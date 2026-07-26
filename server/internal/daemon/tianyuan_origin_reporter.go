package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

var ErrTianYuanOriginUnavailable = errors.New("TianYuan origin reporter unavailable")

type TianYuanReplayCounts struct{ Scanned, Reported, Skipped, Failed int }

// ReplayTianYuanSessionOrigins processes only the content-free rows returned
// by the explicit daemon API. It is never called during daemon startup.
func ReplayTianYuanSessionOrigins(ctx context.Context, cfg Config, rows []SessionOrigin, report func(context.Context, Config, Task, string, string, string, *slog.Logger) error, logger *slog.Logger) TianYuanReplayCounts {
	counts := TianYuanReplayCounts{Scanned: len(rows)}
	if cfg.TianYuanOriginReportURL == "" {
		counts.Skipped = len(rows)
		return counts
	}
	for _, row := range rows {
		if strings.TrimSpace(row.SessionID) == "" || strings.TrimSpace(row.Provider) == "" {
			counts.Skipped++
			continue
		}
		task := Task{ID: row.TaskID, IssueID: row.IssueID, ProjectID: row.ProjectIdentity}
		if err := report(ctx, cfg, task, row.Provider, row.SessionID, row.WorkDir, logger); err != nil {
			counts.Failed++
			continue
		}
		counts.Reported++
	}
	return counts
}

// ReportTianYuanOrigin is deliberately daemon-owned: providers expose only a
// native session id and never learn TianYuan's address or credential.
func ReportTianYuanOrigin(ctx context.Context, cfg Config, task Task, provider, sessionID, observedCwd string, logger *slog.Logger) error {
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
	if task.ProjectID != "" {
		payload["projectIdentity"] = task.ProjectID
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return ErrTianYuanOriginUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.TianYuanOriginReportURL, bytes.NewReader(body))
	if err != nil {
		return ErrTianYuanOriginUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	if key := strings.TrimSpace(cfg.TianYuanOriginReportPathKey); key != "" {
		req.Header.Set("x-tianyuan-path-key", key)
	}
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return ErrTianYuanOriginUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ErrTianYuanOriginUnavailable
	}
	return nil
}

// ReportTianYuanDiagnostic records a provider-native discovery boundary only.
func ReportTianYuanDiagnostic(ctx context.Context, cfg Config, provider, sessionID, evidence string) error {
	if cfg.TianYuanOriginReportURL == "" || provider == "" || sessionID == "" {
		return nil
	}
	payload, _ := json.Marshal(map[string]any{"schemaVersion": 1, "deviceId": "ty-mac-main", "provider": provider, "nativeSessionId": sessionID, "origin": "diagnostic", "lineageKind": "diagnostic", "lineageEvidence": "provider_native", "originKind": evidence, "originId": sessionID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.TianYuanOriginReportURL, bytes.NewReader(payload))
	if err != nil {
		return ErrTianYuanOriginUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	if key := strings.TrimSpace(cfg.TianYuanOriginReportPathKey); key != "" {
		req.Header.Set("x-tianyuan-path-key", key)
	}
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return ErrTianYuanOriginUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ErrTianYuanOriginUnavailable
	}
	return nil
}
