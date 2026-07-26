package agent

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// WorkBuddy ships its headless stream-json engine as a Node script inside the
// WorkBuddy Desktop app instead of installing a `workbuddy` binary on PATH.
// A GUI-launched daemon has no shell-installed node (nvm/fnm prefixes never
// reach its PATH), so every launch of that engine — task execution, version
// detection, model discovery — must run through the app's own Electron binary
// as Node (ELECTRON_RUN_AS_NODE=1), with the CLI script as the first prefix
// argument. See the codebuddy backend for the shared stream-json protocol.

const workbuddyBundledCLISuffix = "/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"

// WorkbuddyAppBundlePaths returns the app-bundled engine CLI candidates
// installed by WorkBuddy Desktop. A var so tests can stage a fake app.
var WorkbuddyAppBundlePaths = func() []string {
	paths := []string{filepath.Join("/Applications/WorkBuddy.app", workbuddyBundledCLISuffix)}
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths, filepath.Join(home, "Applications", "WorkBuddy.app", workbuddyBundledCLISuffix))
	}
	return paths
}

// workbuddyElectronForCLI returns the app's Electron binary that hosts a
// bundled engine CLI path, "" when the path is not a WorkBuddy app layout,
// and an error when the layout matches but the Electron binary is missing or
// not executable.
func workbuddyElectronForCLI(executablePath string) (string, error) {
	clean := filepath.ToSlash(filepath.Clean(executablePath))
	if !strings.HasSuffix(clean, workbuddyBundledCLISuffix) {
		return "", nil
	}
	appRoot := strings.TrimSuffix(clean, workbuddyBundledCLISuffix)
	electronPath := filepath.FromSlash(appRoot + "/Contents/MacOS/Electron")
	info, err := os.Stat(electronPath)
	if err != nil || info.IsDir() || info.Mode().Perm()&0o111 == 0 {
		if err == nil {
			err = fmt.Errorf("not an executable file")
		}
		return "", fmt.Errorf("workbuddy app runtime not executable at %q: %w", electronPath, err)
	}
	return electronPath, nil
}

// buddyLaunchCommand rewrites a launch that targets the WorkBuddy-bundled
// engine CLI to run as Electron-as-Node with the CLI script ahead of the
// configured launch prefix. Non-WorkBuddy paths pass through untouched, so
// CodeBuddy launches stay byte-identical. The returned env overlay must be
// merged into the spawned process's environment by the caller.
func buddyLaunchCommand(cfg Config, executablePath string) (Command, map[string]string, error) {
	electronPath, err := workbuddyElectronForCLI(executablePath)
	if err != nil {
		return Command{}, nil, err
	}
	if electronPath == "" {
		return cfg.commandAt(executablePath), nil, nil
	}
	prefix := append([]string{executablePath}, cfg.LaunchPrefix...)
	return Command{
		Path:   electronPath,
		Prefix: prefix,
		logger: cfg.Logger,
	}, map[string]string{"ELECTRON_RUN_AS_NODE": "1"}, nil
}

// mergeLaunchEnv overlays launch-specific variables (the WorkBuddy
// ELECTRON_RUN_AS_NODE switch) onto the task's configured env.
func mergeLaunchEnv(base, overlay map[string]string) map[string]string {
	if len(overlay) == 0 {
		return base
	}
	merged := make(map[string]string, len(base)+len(overlay))
	for k, v := range base {
		merged[k] = v
	}
	for k, v := range overlay {
		merged[k] = v
	}
	return merged
}

// discoverWorkbuddyModels runs the codebuddy-family ACP discovery against the
// WorkBuddy-bundled engine, wrapped in the app's Electron-as-Node launcher.
// A path outside a WorkBuddy app (a shell-installed workbuddy shim) needs no
// wrapper and reuses the plain codebuddy discovery.
func discoverWorkbuddyModels(ctx context.Context, runtimeCmd Command) ([]Model, error) {
	electronPath, err := workbuddyElectronForCLI(runtimeCmd.Path)
	if err != nil {
		return nil, err
	}
	if electronPath == "" {
		catalog, err := discoverCodebuddyModels(ctx, runtimeCmd)
		return catalog.Models, err
	}
	wrapped := Command{
		Path:   electronPath,
		Prefix: append([]string{runtimeCmd.Path}, runtimeCmd.Prefix...),
		logger: runtimeCmd.logger,
	}
	models, err := discoverACPModels(ctx, wrapped, acpDiscoveryProvider{
		defaultBin:   "codebuddy",
		clientName:   "multica-model-discovery",
		tmpdirPrefix: "multica-workbuddy-discovery-",
		acpArgs:      []string{"--acp"},
		strictErrors: true,
		extraEnv:     []string{"ELECTRON_RUN_AS_NODE=1"},
		annotate:     annotateCodebuddyThinkingFromACP,
	})
	if err != nil || len(models) == 0 {
		if err != nil {
			slog.Debug("workbuddy model discovery fell back to static catalog", "error", err)
		}
		fallback := codebuddyFallbackCatalog()
		return fallback.Models, nil
	}
	for i := range models {
		if models[i].Provider == "" {
			models[i].Provider = codebuddyModelProvider(models[i].ID)
		}
	}
	return models, nil
}

// DetectWorkbuddyVersion probes the engine version through the Electron-as-
// Node wrapper, for entries whose path points into a WorkBuddy app. Paths
// outside a WorkBuddy app answer false and the caller falls back to the plain
// CLI probe.
func DetectWorkbuddyVersion(ctx context.Context, cmd Command) (string, bool, error) {
	electronPath, err := workbuddyElectronForCLI(cmd.Path)
	if err != nil {
		return "", true, err
	}
	if electronPath == "" {
		return "", false, nil
	}
	wrapped := Command{
		Path:   electronPath,
		Prefix: append([]string{cmd.Path}, cmd.Prefix...),
		logger: cmd.logger,
	}
	probe := wrapped.exec(ctx, "--version")
	hideAgentWindow(probe)
	probe.WaitDelay = probeWaitDelay
	probe.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
	data, err := outputOwned(probe, wrapped.logger)
	version, _ := extractVersionLine(string(data))
	if version == "" && err != nil {
		return "", true, err
	}
	if version == "" {
		return "", true, fmt.Errorf("workbuddy returned an empty version")
	}
	return version, true, nil
}
