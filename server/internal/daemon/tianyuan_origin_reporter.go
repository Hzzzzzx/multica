package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

// reportTianYuanOrigin is deliberately daemon-owned: providers expose only a
// native session id and never learn TianYuan's address or credential.
func reportTianYuanOrigin(ctx context.Context, cfg Config, task Task, provider, sessionID, observedCwd string, logger *slog.Logger) error {
	if cfg.TianYuanOriginReportURL == "" || sessionID == "" || provider == "" {
		return nil
	}
	origin, reference := "multica_task", task.ID
	if task.IssueID != "" {
		origin, reference = "multica_issue", task.IssueID
	}
	payload := map[string]any{
		"schemaVersion":   1,
		"deviceId":        "ty-mac-main",
		"provider":        provider,
		"nativeSessionId": sessionID,
		"observedCwd":     observedCwd,
		"origin":          origin,
		"originReference": reference,
		"lineageKind":     "delegated_execution",
		"lineageEvidence": "multica_task",
		"originKind":      origin,
		"originId":        reference,
	}
	if task.ProjectTitle != "" {
		payload["projectTitle"] = task.ProjectTitle
	}
	if observedCwd != "" {
		if root, err := filepath.EvalSymlinks(observedCwd); err == nil {
			payload["canonicalProjectRoot"] = root
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode TianYuan origin payload: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.TianYuanOriginReportURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create TianYuan origin request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if key := strings.TrimSpace(cfg.TianYuanOriginReportPathKey); key != "" {
		req.Header.Set("x-tianyuan-path-key", key)
	}
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("post TianYuan origin: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("TianYuan origin returned %d", resp.StatusCode)
	}
	return nil
}
