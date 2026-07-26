package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

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
	err := reportTianYuanOrigin(context.Background(), Config{TianYuanOriginReportURL: srv.URL, TianYuanOriginReportPathKey: "path-key"}, Task{ID: "task-1", IssueID: "issue-1", ProjectTitle: "Project"}, "codex", "thread-1", "/does/not/exist", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got["provider"] != "codex" || got["nativeSessionId"] != "thread-1" || got["originKind"] != "multica_issue" || got["originId"] != "issue-1" {
		t.Fatalf("unexpected payload: %#v", got)
	}
}

func TestReportTianYuanOriginFailureIsReturnedForCallerToDegrade(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	defer srv.Close()
	if err := reportTianYuanOrigin(context.Background(), Config{TianYuanOriginReportURL: srv.URL}, Task{ID: "task-1"}, "opencode", "ses-1", "/tmp", nil); err == nil {
		t.Fatal("expected reporter failure")
	}
}
