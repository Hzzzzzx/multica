// Locate the official ZCode CLI (`zcode.cjs` / `zcode`) that Multica will
// drive in headless mode.
//
// Discovery order:
//   1. $MULTICA_ZCODE_CLI — explicit path to the CLI entry (zcode.cjs or bin)
//   2. $MULTICA_ZCODE_APP/Contents/Resources/glm/zcode.cjs
//   3. /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
//   4. `zcode` on PATH (must not be this shim itself)
//
// We intentionally do NOT host the Electron `out/host/index.js` worker.
// ZCode.app's real agent surface for headless use is the bundled CLI
// (`glm/zcode.cjs`), which already supports `--prompt` and `app-server`.

import { promises as fs } from "node:fs";
import { accessSync, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_APP = "/Applications/ZCode.app";
const BUNDLED_CLI_REL = path.join("Contents", "Resources", "glm", "zcode.cjs");

export interface ZcodeCliPaths {
  /** Absolute path to the CLI entry script/binary. */
  cliPath: string;
  /** How the CLI should be launched: node script or already-executable bin. */
  kind: "node-script" | "bin";
  /** Optional .app bundle the CLI was discovered inside. */
  appBundle?: string;
  /** Short version string if we can read it (best-effort). */
  version?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function classifyCli(cliPath: string): Promise<"node-script" | "bin"> {
  if (cliPath.endsWith(".cjs") || cliPath.endsWith(".js") || cliPath.endsWith(".mjs")) {
    return "node-script";
  }
  // Shebang scripts / native binaries are both fine as `bin`.
  return "bin";
}

async function fromAppBundle(appBundle: string): Promise<ZcodeCliPaths | null> {
  const cliPath = path.join(appBundle, BUNDLED_CLI_REL);
  if (!(await pathExists(cliPath))) return null;
  let version: string | undefined;
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        path.join(appBundle, "Contents", "Info.plist"),
      ],
      { timeout: 5_000 },
    );
    version = stdout.trim() || undefined;
  } catch {
    // version is optional
  }
  return {
    cliPath,
    kind: await classifyCli(cliPath),
    appBundle,
    version,
  };
}

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [cmd], { timeout: 3_000 });
    const p = stdout.trim().split("\n")[0]?.trim();
    return p && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/**
 * Resolve realpath; on failure return the original path. Used to avoid
 * treating this shim (also named zcode-runtime on PATH) as the real CLI.
 */
async function real(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

export async function locateZcodeCli(): Promise<ZcodeCliPaths> {
  const envCli = process.env["MULTICA_ZCODE_CLI"]?.trim();
  if (envCli) {
    if (!(await pathExists(envCli))) {
      throw new Error(`MULTICA_ZCODE_CLI=${envCli} does not exist`);
    }
    return { cliPath: envCli, kind: await classifyCli(envCli) };
  }

  const envApp = process.env["MULTICA_ZCODE_APP"]?.trim();
  if (envApp) {
    const found = await fromAppBundle(envApp);
    if (found) return found;
    throw new Error(
      `MULTICA_ZCODE_APP=${envApp} has no CLI at ${path.join(envApp, BUNDLED_CLI_REL)}`,
    );
  }

  if (process.platform === "darwin" && (await pathExists(DEFAULT_APP))) {
    const found = await fromAppBundle(DEFAULT_APP);
    if (found) return found;
  }

  // PATH lookup: prefer a real `zcode` binary, never this shim.
  const onPath = await which("zcode");
  if (onPath) {
    const resolved = await real(onPath);
    // Reject if PATH zcode is our own shim (name contains zcode-runtime).
    if (!resolved.includes("zcode-runtime")) {
      return { cliPath: resolved, kind: await classifyCli(resolved) };
    }
  }

  throw new Error(
    "ZCode CLI not found. Install ZCode.app, put `zcode` on PATH, or set " +
      "MULTICA_ZCODE_CLI to glm/zcode.cjs (or MULTICA_ZCODE_APP to the .app bundle).",
  );
}

/** Build the argv prefix used to invoke the CLI (without user args). */
export function cliLaunchPrefix(paths: ZcodeCliPaths): string[] {
  if (paths.kind === "node-script") {
    // Prefer the same node that is running this shim.
    return [process.execPath, paths.cliPath];
  }
  if (isExecutable(paths.cliPath)) {
    return [paths.cliPath];
  }
  // Fallback: try node even for non-.cjs paths.
  return [process.execPath, paths.cliPath];
}

export function defaultCacheHint(): string {
  return path.join(os.homedir(), ".zcode", "cli");
}
