// Run one headless ZCode CLI prompt and stream stdout/stderr lines.
//
// Multica tasks are unattended, so we always use `--mode yolo` unless the
// caller overrides via env MULTICA_ZCODE_MODE.
//
// Model selection:
//   Setting ZCODE_MODEL alone switches the CLI onto its env-config path,
//   which requires ANTHROPIC_API_KEY and ignores provider.apiKey in
//   ~/.zcode/cli/config.json. We therefore load the file config and inject
//   the matching provider key when Multica (or --model) picks a model.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ZcodeCliPaths } from "./locate-cli.mts";
import { cliLaunchPrefix } from "./locate-cli.mts";

export interface RunPromptOptions {
  paths: ZcodeCliPaths;
  workspace: string;
  prompt: string;
  model?: string;
  /** Abort signal for Multica cancel / timeout. */
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface RunPromptResult {
  code: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}

function splitLines(
  chunk: string,
  carry: { value: string },
  onLine: ((line: string) => void) | undefined,
): void {
  carry.value += chunk;
  let idx: number;
  while ((idx = carry.value.indexOf("\n")) !== -1) {
    const line = carry.value.slice(0, idx);
    carry.value = carry.value.slice(idx + 1);
    onLine?.(line);
  }
}

interface CliFileConfig {
  provider?: Record<
    string,
    {
      options?: {
        apiKey?: string;
        baseURL?: string;
      };
    }
  >;
  model?: {
    main?: string;
    lite?: string;
  };
}

async function loadCliFileConfig(): Promise<CliFileConfig | null> {
  const p = path.join(os.homedir(), ".zcode", "cli", "config.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as CliFileConfig;
  } catch {
    return null;
  }
}

/** providerId from "bigmodel/glm-5.1" or bare model id. */
function providerIdFromModel(model: string): string | undefined {
  const i = model.indexOf("/");
  if (i <= 0) return undefined;
  return model.slice(0, i).trim() || undefined;
}

async function buildChildEnv(model?: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Headless Multica runs should not open a browser for OAuth mid-task.
    CI: process.env["CI"] ?? "1",
  };

  const fileCfg = await loadCliFileConfig();
  const effectiveModel =
    (model && model.trim()) ||
    (typeof fileCfg?.model?.main === "string" ? fileCfg.model.main : undefined);

  // When Multica passes --model we set ZCODE_MODEL; the CLI then expects an
  // Anthropic-compatible API key via env. Seed it from file config.
  if (model && model.trim()) {
    env["ZCODE_MODEL"] = model.trim();
  }

  const providerId = effectiveModel
    ? providerIdFromModel(effectiveModel)
    : undefined;
  const provider =
    providerId && fileCfg?.provider
      ? fileCfg.provider[providerId]
      : undefined;
  const apiKey = provider?.options?.apiKey?.trim();
  const baseURL = provider?.options?.baseURL?.trim();

  if (apiKey && !env["ANTHROPIC_API_KEY"]) {
    env["ANTHROPIC_API_KEY"] = apiKey;
  }
  if (baseURL && !env["ZCODE_BASE_URL"] && model?.trim()) {
    // Only meaningful alongside ZCODE_MODEL (env model path).
    env["ZCODE_BASE_URL"] = baseURL;
  }

  if (model?.trim() && !apiKey && !env["ANTHROPIC_API_KEY"]) {
    process.stderr.write(
      `[zcode-runtime] warning: model ${model} selected but no apiKey found in ` +
        `~/.zcode/cli/config.json for provider ${providerId ?? "?"} — ` +
        "CLI may fail with provider_not_configured. Run `zcode login`.\n",
    );
  }

  return env;
}

export async function runZcodePrompt(
  opts: RunPromptOptions,
): Promise<RunPromptResult> {
  const prefix = cliLaunchPrefix(opts.paths);
  const mode = (process.env["MULTICA_ZCODE_MODE"] || "yolo").trim() || "yolo";

  const args = [
    ...prefix.slice(1),
    "--cwd",
    opts.workspace,
    "--mode",
    mode,
    "--prompt",
    opts.prompt,
  ];

  const env = await buildChildEnv(opts.model);

  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(prefix[0]!, args, {
        cwd: opts.workspace,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    const outCarry = { value: "" };
    const errCarry = { value: "" };

    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      // Escalate if the CLI ignores SIGTERM.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 3_000).unref?.();
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      splitLines(chunk, outCarry, opts.onStdoutLine);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      splitLines(chunk, errCarry, opts.onStderrLine);
    });

    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code, signal) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (outCarry.value) opts.onStdoutLine?.(outCarry.value);
      if (errCarry.value) opts.onStderrLine?.(errCarry.value);
      resolve({ code, stdout, stderr, signal });
    });
  });
}
