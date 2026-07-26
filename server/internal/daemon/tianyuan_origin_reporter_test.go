package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
)

type statusBackend struct{ sessionID string }

func (b statusBackend) Execute(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
	messages := make(chan agent.Message, 1)
	messages <- agent.Message{Type: agent.MessageStatus, Status: "running", SessionID: b.sessionID}
	close(messages)
	results := make(chan agent.Result, 1)
	results <- agent.Result{Status: "completed", SessionID: b.sessionID}
	close(results)
	return &agent.Session{Messages: messages, Result: results}, nil
}

func TestReportTianYuanOriginUsesExactNativeSessionAndIssue(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-tianyuan-path-key") != "path-key" {
			t.Fatal("missing path key")
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	err := ReportTianYuanOrigin(context.Background(), Config{TianYuanOriginReportURL: srv.URL, TianYuanOriginReportPathKey: "path-key"}, Task{ID: "task-1", IssueID: "issue-1", ProjectID: "project-1"}, "codex", "thread-1", "/does/not/exist", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got["provider"] != "codex" || got["nativeSessionId"] != "thread-1" || got["originKind"] != "multica_issue" || got["originId"] != "issue-1" {
		t.Fatalf("unexpected payload: %#v", got)
	}
	if got["projectIdentity"] != "project-1" || got["canonicalProjectRoot"] != nil {
		t.Fatalf("unexpected project payload: %#v", got)
	}
}

func TestReportTianYuanOriginFailureIsReturnedForCallerToDegrade(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	defer srv.Close()
	if err := ReportTianYuanOrigin(context.Background(), Config{TianYuanOriginReportURL: srv.URL}, Task{ID: "task-1"}, "opencode", "ses-1", "/tmp", nil); err == nil {
		t.Fatal("expected reporter failure")
	}
}

func TestReportTianYuanOriginTransportFailureDoesNotExposeEndpoint(t *testing.T) {
	const endpoint = "http://127.0.0.1:1/private-origin"
	err := ReportTianYuanOrigin(context.Background(), Config{TianYuanOriginReportURL: endpoint, TianYuanOriginReportPathKey: "private-key"}, Task{ID: "task-1"}, "opencode", "ses-1", "/tmp", nil)
	if !errors.Is(err, ErrTianYuanOriginUnavailable) {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), endpoint) || strings.Contains(err.Error(), "private-key") {
		t.Fatalf("leaked endpoint in %q", err)
	}
}

func TestReportTianYuanDiagnosticUsesStrictSessionEvidence(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-tianyuan-path-key") != "path-key" {
			t.Fatal("missing path key")
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	err := ReportTianYuanDiagnostic(
		context.Background(),
		Config{TianYuanOriginReportURL: srv.URL, TianYuanOriginReportPathKey: "path-key"},
		"grok",
		"ses-native",
		"/tmp/provider-created-cwd",
		"diagnostic.model_discovery",
	)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"schemaVersion":   float64(1),
		"deviceId":        "ty-mac-main",
		"provider":        "grok",
		"nativeSessionId": "ses-native",
		"observedCwd":     "/tmp/provider-created-cwd",
		"origin":          "diagnostic",
		"lineageKind":     "diagnostic",
		"lineageEvidence": "provider_native",
		"originKind":      "diagnostic.model_discovery",
		"originId":        "ses-native",
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("%s = %#v, want %#v; payload=%#v", key, got[key], value, got)
		}
	}
	if _, present := got["canonicalProjectRoot"]; present {
		t.Fatalf("diagnostic payload must not infer a project root: %#v", got)
	}
}

func TestReplayTianYuanSessionOriginsUsesOnlyExactRowsAndContinues(t *testing.T) {
	var calls []string
	report := func(_ context.Context, _ Config, _ Task, provider, sessionID, _ string, _ *slog.Logger) error {
		calls = append(calls, provider+":"+sessionID)
		if sessionID == "bad" {
			return errors.New("down")
		}
		return nil
	}
	counts := ReplayTianYuanSessionOrigins(context.Background(), Config{TianYuanOriginReportURL: "http://127.0.0.1"}, []SessionOrigin{{TaskID: "one", Provider: "codex", SessionID: "exact"}, {TaskID: "two", Provider: "kimi"}, {TaskID: "three", Provider: "opencode", SessionID: "bad"}}, report, nil)
	if counts != (TianYuanReplayCounts{Scanned: 3, Reported: 1, Skipped: 1, Failed: 1}) {
		t.Fatalf("counts = %#v", counts)
	}
	if len(calls) != 2 {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestReplayTianYuanSessionOriginsSkipsWhenDisabled(t *testing.T) {
	counts := ReplayTianYuanSessionOrigins(context.Background(), Config{}, []SessionOrigin{{TaskID: "one", Provider: "codex", SessionID: "exact"}}, func(context.Context, Config, Task, string, string, string, *slog.Logger) error {
		t.Fatal("report should not run")
		return nil
	}, nil)
	if counts != (TianYuanReplayCounts{Scanned: 1, Skipped: 1}) {
		t.Fatalf("counts = %#v", counts)
	}
}

func TestExecuteAndDrainPinsBeforeReportingAndDegradesReporterFailure(t *testing.T) {
	var pins, reports atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/daemon/tasks/task-1/session" {
			pins.Add(1)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		t.Fatalf("unexpected path %s", r.URL.Path)
	}))
	defer srv.Close()
	d := &Daemon{client: NewClient(srv.URL), logger: slog.Default(), originReporter: func(context.Context, Config, Task, string, string, string, *slog.Logger) error {
		reports.Add(1)
		return errors.New("down")
	}}
	d.sessionOrigins.Store("task-1", taskOrigin{task: Task{ID: "task-1", IssueID: "issue-1"}, provider: "codex"})
	var seq atomic.Int32
	if _, _, err := d.executeAndDrain(context.Background(), statusBackend{sessionID: "exact"}, "", agent.ExecOptions{Cwd: "/tmp"}, slog.Default(), "task-1", &seq); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for pins.Load() != 1 || reports.Load() != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("pins=%d reports=%d", pins.Load(), reports.Load())
		}
		time.Sleep(time.Millisecond)
	}
}
