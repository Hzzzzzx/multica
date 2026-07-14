package agent

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// zcodeBlockedArgs are flags hardcoded by the daemon that must not be
// overridden by user-configured custom_args. These control the shim's
// runtime contract with ZCode.app and changing them would break
// the daemon↔zcode-runtime communication.
var zcodeBlockedArgs = map[string]blockedArgMode{
	"--workspace": blockedWithValue,
	"--model":     blockedWithValue,
	"--stdio":     blockedStandalone,
}

// zcodeBackend implements Backend by spawning `zcode-runtime` and
// communicating via ACP (Agent Client Protocol) JSON-RPC 2.0 over
// stdin/stdout.
//
// The shim (packages/zcode-runtime) is a thin ACP adapter over the
// official ZCode CLI bundled with ZCode.app:
//
//	node …/glm/zcode.cjs --cwd <workspace> --mode yolo --prompt <text>
//
// Discovery (inside the shim): MULTICA_ZCODE_CLI → MULTICA_ZCODE_APP →
// /Applications/ZCode.app → `zcode` on PATH.
//
// Command shape Multica uses:
//
//	zcode-runtime --workspace <cwd> [--model <provider/model>] [--stdio]
//
// Model is forwarded as ZCODE_MODEL. Headless Multica tasks use
// MULTICA_ZCODE_MODE (default yolo). Credentials come from
// ~/.zcode/cli/config.json (seed from desktop via `zcode login` or
// Multica ops docs).
type zcodeBackend struct {
	cfg Config
}

func (b *zcodeBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	execPath := b.cfg.ExecutablePath
	if execPath == "" {
		execPath = "zcode-runtime"
	}
	if _, err := exec.LookPath(execPath); err != nil {
		return nil, fmt.Errorf("zcode-runtime executable not found at %q: %w", execPath, err)
	}

	timeout := opts.Timeout
	runCtx, cancel := runContext(ctx, timeout)

	cwd := opts.Cwd
	if cwd == "" {
		cwd = "."
	}

	zcodeArgs := []string{
		"--workspace", cwd,
	}
	if opts.Model != "" {
		zcodeArgs = append(zcodeArgs, "--model", opts.Model)
	}
	zcodeArgs = append(zcodeArgs, "--stdio")
	zcodeArgs = append(zcodeArgs, filterCustomArgs(opts.CustomArgs, zcodeBlockedArgs, b.cfg.Logger)...)

	cmd := exec.CommandContext(runCtx, execPath, zcodeArgs...)
	hideAgentWindow(cmd)
	b.cfg.Logger.Info("agent command", "exec", execPath, "args", zcodeArgs)

	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
		if _, err := os.Stat(filepath.Join(opts.Cwd, "AGENTS.md")); err == nil {
			// Log only — ZCode loads AGENTS.md itself via its host, we
			// don't need to inject it.
			b.cfg.Logger.Debug("zcode-runtime workspace has AGENTS.md", "cwd", opts.Cwd)
		}
	}
	if opts.SystemPrompt != "" {
		b.cfg.Logger.Debug("zcode-runtime ignoring ExecOptions.SystemPrompt; using cwd-scoped context files", "cwd", opts.Cwd)
	}

	env := buildEnv(b.cfg.Env)
	cmd.Env = env

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("zcode stdout pipe: %w", err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("zcode stdin pipe: %w", err)
	}

	providerErr := newACPProviderErrorSniffer("zcode")
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("zcode stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start zcode-runtime: %w", err)
	}

	stderrSink := io.MultiWriter(newLogWriter(b.cfg.Logger, "[zcode:stderr] "), providerErr)
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		_, _ = io.Copy(stderrSink, stderr)
	}()

	b.cfg.Logger.Info("zcode-runtime started", "pid", cmd.Process.Pid, "cwd", opts.Cwd)

	msgCh := make(chan Message, 256)
	resCh := make(chan Result, 1)

	var outputMu sync.Mutex
	var output strings.Builder
	var streamingCurrentTurn atomic.Bool

	promptDone := make(chan hermesPromptResult, 1)

	// Reuse the hermesClient — it implements the full ACP JSON-RPC 2.0
	// transport (initialize, session/*, session/update parsing, tool
	// call streaming, usage tracking, permission auto-approval).
	// ZCode's shim speaks the same protocol as Hermes/Chrys, so the
	// client code is identical.
	c := &hermesClient{
		cfg:          b.cfg,
		stdin:        stdin,
		pending:      make(map[int]*pendingRPC),
		pendingTools: make(map[string]*pendingToolCall),
		acceptNotification: func(string) bool {
			return streamingCurrentTurn.Load()
		},
		onMessage: func(msg Message) {
			if !streamingCurrentTurn.Load() {
				return
			}
			if msg.Type == MessageText {
				outputMu.Lock()
				output.WriteString(msg.Content)
				outputMu.Unlock()
			}
			trySend(msgCh, msg)
		},
		onPromptDone: func(result hermesPromptResult) {
			if !streamingCurrentTurn.Load() {
				return
			}
			select {
			case promptDone <- result:
			default:
			}
		},
	}

	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			c.handleLine(line)
		}
		c.closeAllPending(fmt.Errorf("zcode-runtime process exited"))
	}()

	go func() {
		defer cancel()
		defer close(msgCh)
		defer close(resCh)
		defer func() {
			stdin.Close()
			_ = cmd.Wait()
		}()

		startTime := time.Now()
		finalStatus := "completed"
		var finalError string
		var sessionID string
		effectiveModel := strings.TrimSpace(opts.Model)

		// 1. Initialize handshake.
		_, err := c.request(runCtx, "initialize", map[string]any{
			"protocolVersion": 1,
			"clientInfo": map[string]any{
				"name":    "multica-agent-sdk",
				"version": "0.2.0",
			},
			"clientCapabilities": map[string]any{},
		})
		if err != nil {
			finalStatus = "failed"
			finalError = fmt.Sprintf("zcode initialize failed: %v", err)
			resCh <- Result{Status: finalStatus, Error: finalError, DurationMs: time.Since(startTime).Milliseconds()}
			return
		}

		// 2. Create or resume a session.
		//
		// ZCode's shim v1 only implements session/new; session/resume
		// is not yet wired through the mapper. We always create fresh
		// sessions for now — callers that need persistence can use the
		// ZCode desktop app's own task index and pass --model to keep
		// the workspace state.
		if opts.ResumeSessionID != "" {
			b.cfg.Logger.Warn("zcode-runtime: session/resume not yet implemented in shim; creating a new session instead",
				"requested_session_id", opts.ResumeSessionID,
			)
		}
		result, err := c.request(runCtx, "session/new", buildZcodeSessionParams(cwd, opts.Model))
		if err != nil {
			finalStatus = "failed"
			finalError = fmt.Sprintf("zcode session/new failed: %v", err)
			resCh <- Result{Status: finalStatus, Error: finalError, DurationMs: time.Since(startTime).Milliseconds()}
			return
		}
		sessionID = extractACPSessionID(result)
		if sessionID == "" {
			finalStatus = "failed"
			finalError = "zcode session/new returned no session ID"
			resCh <- Result{Status: finalStatus, Error: finalError, DurationMs: time.Since(startTime).Milliseconds()}
			return
		}
		if effectiveModel == "" {
			effectiveModel = extractACPCurrentModelID(result)
		}

		c.sessionID = sessionID
		b.cfg.Logger.Info("zcode session created", "session_id", sessionID, "model", effectiveModel)

		// 3. Note: we skip session/set_model for ZCode. The model is
		// baked in at shim startup (--model flag); ZCode's host treats
		// it as the session default. Runtime model switching would need
		// a new ACP method from the shim; deferred.

		// 4. Send the prompt.
		streamingCurrentTurn.Store(true)
		_, err = c.request(runCtx, "session/prompt", map[string]any{
			"sessionId": sessionID,
			"prompt": []map[string]any{
				{"type": "text", "text": prompt},
			},
		})
		if err != nil {
			if runCtx.Err() == context.DeadlineExceeded {
				finalStatus = "timeout"
				finalError = fmt.Sprintf("zcode timed out after %s", timeout)
			} else if runCtx.Err() == context.Canceled {
				finalStatus = "aborted"
				finalError = "execution cancelled"
			} else {
				finalStatus = "failed"
				finalError = fmt.Sprintf("zcode session/prompt failed: %v", err)
			}
		} else {
			select {
			case pr := <-promptDone:
				if pr.stopReason == "cancelled" {
					finalStatus = "aborted"
					finalError = "zcode cancelled the prompt"
				}
				c.usageMu.Lock()
				c.usage.InputTokens += pr.usage.InputTokens
				c.usage.OutputTokens += pr.usage.OutputTokens
				c.usage.CacheReadTokens += pr.usage.CacheReadTokens
				c.usageMu.Unlock()
			default:
			}
		}

		duration := time.Since(startTime)
		b.cfg.Logger.Info("zcode finished", "pid", cmd.Process.Pid, "status", finalStatus, "duration", duration.Round(time.Millisecond).String())

		stdin.Close()
		cancel()

		<-readerDone
		<-stderrDone

		outputMu.Lock()
		finalOutput := output.String()
		outputMu.Unlock()

		finalStatus, finalError = promoteACPResultOnProviderError(finalStatus, finalError, finalOutput, providerErr)

		c.usageMu.Lock()
		u := c.usage
		c.usageMu.Unlock()

		var usageMap map[string]TokenUsage
		if u.InputTokens > 0 || u.OutputTokens > 0 || u.CacheReadTokens > 0 {
			model := effectiveModel
			if model == "" {
				model = "unknown"
			}
			usageMap = map[string]TokenUsage{model: u}
		}

		resCh <- Result{
			Status:     finalStatus,
			Output:     finalOutput,
			Error:      finalError,
			DurationMs: duration.Milliseconds(),
			SessionID:  sessionID,
			Usage:      usageMap,
		}
	}()

	return &Session{Messages: msgCh, Result: resCh}, nil
}

// buildZcodeSessionParams constructs the params map for the ACP
// session/new request. ACP schema requires mcpServers (array); ZCode
// manages its own MCP via the desktop/CLI config, so we always send an
// empty list. Model is passed at shim startup via --model / ZCODE_MODEL
// and mirrored here for Multica session metadata.
func buildZcodeSessionParams(cwd, model string) map[string]any {
	params := map[string]any{
		"cwd":        cwd,
		"mcpServers": []any{},
	}
	if model != "" {
		params["model"] = model
	}
	return params
}
