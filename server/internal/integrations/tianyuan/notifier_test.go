package tianyuan

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestNotifierDeliversSignedTaskEvent(t *testing.T) {
	received := make(chan CallbackEvent, 1)
	const secret = "test-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		wantSig := hmacSHA256(secret, raw)
		if got := r.Header.Get("x-tianyuan-signature"); got != wantSig {
			t.Fatalf("signature mismatch: got %q want %q", got, wantSig)
		}
		var event CallbackEvent
		if err := json.Unmarshal(raw, &event); err != nil {
			t.Fatalf("decode callback: %v", err)
		}
		received <- event
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	bus := events.New()
	notifier := NewNotifier(Config{
		CallbackURL: server.URL,
		Secret:      secret,
		Now: func() time.Time {
			return time.Date(2026, 6, 14, 0, 0, 0, 0, time.UTC)
		},
	})
	notifier.Register(bus)

	bus.Publish(events.Event{
		Type:        protocol.EventTaskCompleted,
		WorkspaceID: "workspace_1",
		Payload: map[string]any{
			"task_id":  "task_1",
			"issue_id": "issue_1",
			"agent_id": "agent_1",
			"status":   "completed",
		},
	})

	select {
	case event := <-received:
		if event.Schema != beichenProviderCallbackSchema || event.CallbackKind != "provider.lifecycle" {
			t.Fatalf("unexpected callback identity: %#v", event)
		}
		if event.Provider != "multica" {
			t.Fatalf("provider = %q", event.Provider)
		}
		if event.ProviderEventID != "multica:task:completed:task_1" {
			t.Fatalf("providerEventId = %q", event.ProviderEventID)
		}
		if event.WorkspaceID != "workspace_1" || event.IssueID != "issue_1" || event.TaskID != "task_1" {
			t.Fatalf("unexpected refs: %#v", event)
		}
		if event.External.WorkspaceID != "workspace_1" || event.External.IssueID != "issue_1" || event.External.TaskID != "task_1" {
			t.Fatalf("unexpected external refs: %#v", event.External)
		}
		if event.Actor == nil || event.Actor.Kind != "agent" || event.Actor.AgentID != "agent_1" {
			t.Fatalf("unexpected actor: %#v", event.Actor)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for callback")
	}
}

func TestNotifierDeliversIssueDoneStatusEvent(t *testing.T) {
	received := make(chan CallbackEvent, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		var event CallbackEvent
		if err := json.Unmarshal(raw, &event); err != nil {
			t.Fatalf("decode callback: %v", err)
		}
		received <- event
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	bus := events.New()
	notifier := NewNotifier(Config{
		CallbackURL: server.URL,
		Now: func() time.Time {
			return time.Date(2026, 6, 14, 0, 0, 0, 0, time.UTC)
		},
	})
	notifier.Register(bus)

	bus.Publish(events.Event{
		Type:        protocol.EventIssueUpdated,
		WorkspaceID: "workspace_1",
		Payload: map[string]any{
			"status_changed": true,
			"prev_status":    "todo",
			"issue": map[string]any{
				"id":         "issue_1",
				"identifier": "WOR-9",
				"title":      "自动完成测试",
				"status":     "done",
			},
		},
	})

	select {
	case event := <-received:
		if event.Schema != beichenProviderCallbackSchema || event.CallbackKind != "provider.lifecycle" {
			t.Fatalf("unexpected callback identity: %#v", event)
		}
		if event.ProviderEventID != "multica:issue.status.done:issue_1" {
			t.Fatalf("providerEventId = %q", event.ProviderEventID)
		}
		if event.EventType != "issue.status.done" {
			t.Fatalf("eventType = %q", event.EventType)
		}
		if event.WorkspaceID != "workspace_1" || event.IssueID != "issue_1" || event.TaskID != "" {
			t.Fatalf("unexpected refs: %#v", event)
		}
		if event.External.WorkspaceID != "workspace_1" || event.External.IssueID != "issue_1" || event.External.TaskID != "" {
			t.Fatalf("unexpected external refs: %#v", event.External)
		}
		if event.Actor == nil || event.Actor.Kind != "system" || event.Actor.Role != "status_transition" {
			t.Fatalf("unexpected actor: %#v", event.Actor)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for callback")
	}
}

func hmacSHA256(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}
