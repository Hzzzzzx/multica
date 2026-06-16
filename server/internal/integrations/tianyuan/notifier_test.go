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
			"task_id":    "task_1",
			"issue_id":   "issue_1",
			"agent_id":   "agent_1",
			"status":     "completed",
			"updated_at": "2026-06-14T00:00:00Z",
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
		if event.ProviderEventID != "multica:task:completed:task_1:2026-06-14T00:00:00Z" {
			t.Fatalf("providerEventId = %q", event.ProviderEventID)
		}
		if event.OccurredAt != "2026-06-14T00:00:00Z" {
			t.Fatalf("occurredAt = %q, want injected Now", event.OccurredAt)
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
				"updated_at": "2026-06-14T00:00:00Z",
			},
		},
	})

	select {
	case event := <-received:
		if event.Schema != beichenProviderCallbackSchema || event.CallbackKind != "provider.lifecycle" {
			t.Fatalf("unexpected callback identity: %#v", event)
		}
		if event.ProviderEventID != "multica:issue.status.done:issue_1:2026-06-14T00:00:00Z" {
			t.Fatalf("providerEventId = %q", event.ProviderEventID)
		}
		if event.EventType != "issue.status.done" {
			t.Fatalf("eventType = %q", event.EventType)
		}
		if event.OccurredAt != "2026-06-14T00:00:00Z" {
			t.Fatalf("occurredAt = %q, want injected Now", event.OccurredAt)
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

func TestNotifierDisabledDoesNotDeliver(t *testing.T) {
	hits := make(chan struct{}, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	bus := events.New()
	notifier := NewNotifier(Config{CallbackURL: ""})
	if notifier.Enabled() {
		t.Fatal("notifier should be disabled with an empty callback URL")
	}
	notifier.Register(bus)

	dispatched := make(chan struct{}, 1)
	bus.SubscribeAll(func(events.Event) { dispatched <- struct{}{} })

	bus.Publish(events.Event{
		Type:        protocol.EventTaskCompleted,
		WorkspaceID: "ws",
		Payload:     map[string]any{"task_id": "t1", "updated_at": "2026-06-14T00:00:00Z"},
	})

	select {
	case <-dispatched:
	case <-time.After(time.Second):
		t.Fatal("bus never dispatched the event")
	}
	select {
	case <-hits:
		t.Fatal("disabled notifier delivered a callback")
	case <-time.After(250 * time.Millisecond):
	}
}

func TestNotifierTreatsNonOKAsFailure(t *testing.T) {
	attempts := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts <- struct{}{}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	bus := events.New()
	NewNotifier(Config{CallbackURL: server.URL, Secret: "s"}).Register(bus)

	bus.Publish(events.Event{
		Type:        protocol.EventTaskFailed,
		WorkspaceID: "ws",
		Payload:     map[string]any{"task_id": "t1", "updated_at": "2026-06-14T00:00:00Z"},
	})

	select {
	case <-attempts:
	case <-time.After(2 * time.Second):
		t.Fatal("callback request was never attempted")
	}
	select {
	case <-attempts:
		t.Fatal("notifier retried after a non-2xx response")
	default:
	}
}

func TestMultipleNotifiersEachDeliver(t *testing.T) {
	receivedA := make(chan CallbackEvent, 1)
	receivedB := make(chan CallbackEvent, 1)
	serverA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var ev CallbackEvent
		_ = json.Unmarshal(raw, &ev)
		receivedA <- ev
		w.WriteHeader(http.StatusOK)
	}))
	serverB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var ev CallbackEvent
		_ = json.Unmarshal(raw, &ev)
		receivedB <- ev
		w.WriteHeader(http.StatusOK)
	}))
	defer serverA.Close()
	defer serverB.Close()

	bus := events.New()
	NewNotifier(Config{CallbackURL: serverA.URL, Secret: "a"}).Register(bus)
	NewNotifier(Config{CallbackURL: serverB.URL, Secret: "b"}).Register(bus)

	bus.Publish(events.Event{
		Type:        protocol.EventTaskCompleted,
		WorkspaceID: "ws",
		Payload:     map[string]any{"task_id": "t1", "issue_id": "i1", "updated_at": "2026-06-14T00:00:00Z"},
	})

	for _, ch := range []chan CallbackEvent{receivedA, receivedB} {
		select {
		case ev := <-ch:
			if ev.ProviderEventID != "multica:task:completed:t1:2026-06-14T00:00:00Z" {
				t.Fatalf("providerEventId = %q", ev.ProviderEventID)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("a subscribed notifier did not deliver (multi-replica contract)")
		}
	}
}

func TestNotifierOmitsSignatureWhenSecretEmpty(t *testing.T) {
	received := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Get("x-tianyuan-signature")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	bus := events.New()
	NewNotifier(Config{CallbackURL: server.URL}).Register(bus)

	bus.Publish(events.Event{
		Type:        protocol.EventTaskCompleted,
		WorkspaceID: "ws",
		Payload:     map[string]any{"task_id": "t1", "updated_at": "2026-06-14T00:00:00Z"},
	})

	select {
	case sig := <-received:
		if sig != "" {
			t.Fatalf("expected empty signature header, got %q", sig)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("callback never delivered")
	}
}

func hmacSHA256(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}
