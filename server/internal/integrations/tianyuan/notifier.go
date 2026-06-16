package tianyuan

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	defaultTimeout                = 10 * time.Second
	beichenProviderCallbackSchema = "tianyuan.beichen.provider_callback.v1"
)

// Notifier forwards selected Multica lifecycle events to a TianYuan Beichen
// callback endpoint. It subscribes to the existing event bus and never participates
// in task state transitions.
//
// Multi-replica delivery contract: the event bus (events.Bus) is an in-process
// pub/sub with no cross-replica coordination. In a deployment with N server
// replicas, every replica's Notifier subscribes independently and fires once
// per event, so the SAME lifecycle event is delivered N times to the Beichen
// endpoint. This is an at-least-once, per-replica contract, NOT exactly-once.
// Downstream (Beichen) MUST be idempotent: dedupe on providerEventId, which is
// built from multica:<type>:<id>:<updated_at> and is unique per transition.
// (If Beichen cannot guarantee idempotency, a pg_advisory_lock leader guard
// would be needed — tracked as a separate risk, not implemented here.)
type Notifier struct {
	callbackURL string
	secret      string
	client      *http.Client
	now         func() time.Time
	logger      *slog.Logger
}

type Config struct {
	CallbackURL string
	Secret      string
	Client      *http.Client
	Now         func() time.Time
	Logger      *slog.Logger
}

type CallbackEvent struct {
	Schema       string `json:"schema"`
	CallbackKind string `json:"callbackKind"`
	Provider     string `json:"provider"`
	// ProviderEventID is the idempotency key for downstream dedup. Format:
	// multica:<eventType>:<entityID>:<updated_at>. It is unique per lifecycle
	// transition (updated_at is monotonic) but is NOT stable across replays
	// of the same transition — dedupe on exact-string equality only.
	ProviderEventID string           `json:"providerEventId"`
	EventType       string           `json:"eventType"`
	External        CallbackExternal `json:"external"`
	Actor           *CallbackActor   `json:"actor,omitempty"`
	WorkspaceID     string           `json:"workspaceId,omitempty"`
	IssueID         string           `json:"issueId,omitempty"`
	TaskID          string           `json:"taskId,omitempty"`
	AgentID         string           `json:"agentId,omitempty"`
	OccurredAt      string           `json:"occurredAt"`
	Summary         string           `json:"summary,omitempty"`
	// Payload is forwarded verbatim from the internal event bus payload.
	// Its key set IS the outbound contract to Beichen: adding keys is a
	// compatible change, but renaming or removing keys is breaking and must
	// be coordinated downstream. There is no allowlist today — the entire
	// internal payload shape is exposed (tracked as debt; see B3).
	Payload map[string]any `json:"payload"`
}

type CallbackExternal struct {
	WorkspaceID string `json:"workspaceId,omitempty"`
	IssueID     string `json:"issueId,omitempty"`
	TaskID      string `json:"taskId,omitempty"`
	AgentID     string `json:"agentId,omitempty"`
}

type CallbackActor struct {
	Kind    string `json:"kind"`
	AgentID string `json:"agentId,omitempty"`
	Role    string `json:"role,omitempty"`
}

func NewNotifierFromEnv() *Notifier {
	return NewNotifier(Config{
		CallbackURL: strings.TrimSpace(os.Getenv("MULTICA_TIANYUAN_CALLBACK_URL")),
		Secret:      os.Getenv("MULTICA_TIANYUAN_CALLBACK_SECRET"),
		Logger:      slog.Default(),
	})
}

func NewNotifier(cfg Config) *Notifier {
	client := cfg.Client
	if client == nil {
		client = &http.Client{Timeout: defaultTimeout}
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Notifier{
		callbackURL: strings.TrimSpace(cfg.CallbackURL),
		secret:      cfg.Secret,
		client:      client,
		now:         now,
		logger:      logger,
	}
}

func (n *Notifier) Enabled() bool {
	return n != nil && n.callbackURL != ""
}

// Register subscribes the notifier to the lifecycle events it forwards.
// Idempotent only against a fresh bus; call exactly once during server boot.
//
// See the Notifier type doc for the multi-replica delivery contract: each
// replica delivers independently, so downstream must dedupe on providerEventId.
func (n *Notifier) Register(bus *events.Bus) {
	if !n.Enabled() {
		return
	}
	if n.secret == "" {
		// Warn-only: URL is the opt-in switch, so an unset secret does not
		// disable delivery. But unsigned callbacks cannot be authenticated by
		// Beichen — this must not ship to production.
		n.logger.Warn("tianyuan notifier: CALLBACK_SECRET not set; callbacks will be UNSIGNED and unauthenticated — do not use in production")
	}
	for _, eventType := range []string{
		protocol.EventIssueUpdated,
		protocol.EventTaskRunning,
		protocol.EventTaskCompleted,
		protocol.EventTaskFailed,
		protocol.EventTaskCancelled,
	} {
		bus.Subscribe(eventType, n.handleEvent)
	}
}

func (n *Notifier) handleEvent(e events.Event) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
		defer cancel()
		if err := n.deliver(ctx, e); err != nil {
			n.logger.Warn("tianyuan notifier: event delivery failed",
				"event_type", e.Type,
				"workspace_id", e.WorkspaceID,
				"task_id", taskIDFromPayload(e.Payload),
				"error", err,
			)
		}
	}()
}

func (n *Notifier) deliver(ctx context.Context, e events.Event) error {
	callback, ok := n.callbackEvent(e)
	if !ok {
		return nil
	}
	body, err := json.Marshal(callback)
	if err != nil {
		return fmt.Errorf("marshal callback: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.callbackURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("content-type", "application/json")
	if n.secret != "" {
		req.Header.Set("x-tianyuan-signature", signBody(n.secret, body))
	}

	resp, err := n.client.Do(req)
	if err != nil {
		return fmt.Errorf("post callback: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("callback status %d", resp.StatusCode)
	}
	return nil
}

func (n *Notifier) callbackEvent(e events.Event) (CallbackEvent, bool) {
	if e.Type == protocol.EventIssueUpdated {
		return n.issueCallbackEvent(e)
	}
	return n.taskCallbackEvent(e)
}

func (n *Notifier) issueCallbackEvent(e events.Event) (CallbackEvent, bool) {
	payload, _ := e.Payload.(map[string]any)
	if changed, _ := payload["status_changed"].(bool); !changed {
		return CallbackEvent{}, false
	}

	issue := mapFromAny(payload["issue"])
	issueID := stringFromMap(issue, "id")
	status := stringFromMap(issue, "status")
	if issueID == "" || status == "" {
		return CallbackEvent{}, false
	}

	eventType, ok := issueStatusEventType(status)
	if !ok {
		return CallbackEvent{}, false
	}

	identifier := stringFromMap(issue, "identifier")
	title := stringFromMap(issue, "title")
	updatedAt := stringFromMap(issue, "updated_at")
	return CallbackEvent{
		Schema:          beichenProviderCallbackSchema,
		CallbackKind:    "provider.lifecycle",
		Provider:        "multica",
		ProviderEventID: fmt.Sprintf("multica:%s:%s:%s", eventType, issueID, updatedAt),
		EventType:       eventType,
		External: CallbackExternal{
			WorkspaceID: e.WorkspaceID,
			IssueID:     issueID,
		},
		Actor: &CallbackActor{
			Kind: "system",
			Role: "status_transition",
		},
		WorkspaceID: e.WorkspaceID,
		IssueID:     issueID,
		OccurredAt:  n.now().UTC().Format(time.RFC3339Nano),
		Summary:     issueSummary(status, identifier, title),
		Payload:     payload,
	}, true
}

func (n *Notifier) taskCallbackEvent(e events.Event) (CallbackEvent, bool) {
	payload, _ := e.Payload.(map[string]any)
	taskID := stringFromMap(payload, "task_id")
	if taskID == "" {
		return CallbackEvent{}, false
	}
	issueID := stringFromMap(payload, "issue_id")
	agentID := stringFromMap(payload, "agent_id")
	updatedAt := stringFromMap(payload, "updated_at")
	callback := CallbackEvent{
		Schema:          beichenProviderCallbackSchema,
		CallbackKind:    "provider.lifecycle",
		Provider:        "multica",
		ProviderEventID: fmt.Sprintf("multica:%s:%s:%s", e.Type, taskID, updatedAt),
		EventType:       e.Type,
		External: CallbackExternal{
			WorkspaceID: e.WorkspaceID,
			IssueID:     issueID,
			TaskID:      taskID,
			AgentID:     agentID,
		},
		WorkspaceID: e.WorkspaceID,
		IssueID:     issueID,
		TaskID:      taskID,
		AgentID:     agentID,
		OccurredAt:  n.now().UTC().Format(time.RFC3339Nano),
		Summary:     summaryForEvent(e.Type, taskID),
		Payload:     payload,
	}
	if agentID != "" {
		callback.Actor = &CallbackActor{
			Kind:    "agent",
			AgentID: agentID,
			Role:    "assignee",
		}
	}
	return callback, true
}

func issueStatusEventType(status string) (string, bool) {
	switch status {
	case "done":
		return "issue.status.done", true
	case "blocked":
		return "issue.status.blocked", true
	case "in_review":
		return "issue.status.in_review", true
	case "cancelled":
		return "issue.status.cancelled", true
	default:
		return "", false
	}
}

func issueSummary(status, identifier, title string) string {
	label := strings.TrimSpace(strings.Join([]string{identifier, title}, " "))
	if label == "" {
		return "Multica issue status changed: " + status
	}
	return fmt.Sprintf("Multica issue %s is %s", label, status)
}

func signBody(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func summaryForEvent(eventType, taskID string) string {
	switch eventType {
	case protocol.EventTaskRunning:
		return "Multica task is running: " + taskID
	case protocol.EventTaskCompleted:
		return "Multica task completed: " + taskID
	case protocol.EventTaskFailed:
		return "Multica task failed: " + taskID
	case protocol.EventTaskCancelled:
		return "Multica task cancelled: " + taskID
	default:
		return "Multica event: " + eventType
	}
}

func taskIDFromPayload(payload any) string {
	m, _ := payload.(map[string]any)
	return stringFromMap(m, "task_id")
}

func stringFromMap(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, _ := m[key].(string)
	return v
}

func mapFromAny(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	body, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil
	}
	return out
}
