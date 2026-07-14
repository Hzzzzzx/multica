#!/usr/bin/env node
// Multica ↔ ZCode ACP bridge.
//
// Multica spawns this subprocess and speaks ACP (JSON-RPC 2.0 NDJSON) over
// stdio. Each session/prompt is delegated to the official ZCode CLI:
//
//   node zcode.cjs --cwd <workspace> --mode yolo --prompt <text>
//
// Usage:
//   zcode-runtime --workspace <path> [--model <provider/model>] [--stdio]

import process from "node:process";
import { locateZcodeCli } from "../src/locate-cli.mts";
import { startAcpServer } from "../src/acp-server.mts";
import { createAcpHandlers, type MapperContext } from "../src/mapper.mts";

const VERSION = "0.1.0";

interface Args {
  workspace?: string;
  model?: string;
  help: boolean;
  version: boolean;
  stdio: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { help: false, version: false, stdio: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace" || a === "-w") {
      const v = argv[++i];
      if (typeof v !== "string") throw new Error("--workspace requires a value");
      out.workspace = v;
    } else if (a === "--model" || a === "-m") {
      const v = argv[++i];
      if (typeof v !== "string") throw new Error("--model requires a value");
      out.model = v;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--version" || a === "-V") {
      out.version = true;
    } else if (a === "--stdio") {
      out.stdio = true;
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

const USAGE = `zcode-runtime ${VERSION} — Multica ↔ ZCode CLI ACP bridge

Usage:
  zcode-runtime --workspace <path> [--model <provider/model>]

Options:
  -w, --workspace <path>   Workspace directory (required for ACP sessions)
  -m, --model <id>         Model ref (e.g. bigmodel/glm-5.1); sets ZCODE_MODEL
      --stdio              Use stdio transport (default)
  -h, --help               Show this help
  -V, --version            Print version

Env:
  MULTICA_ZCODE_CLI        Path to zcode.cjs / zcode binary
  MULTICA_ZCODE_APP        Path to ZCode.app (uses Contents/Resources/glm/zcode.cjs)
  MULTICA_ZCODE_MODE       Permission mode (default: yolo)
  ZCODE_MODEL              Fallback model when --model is omitted
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!args.workspace) {
    process.stderr.write("error: --workspace is required\n\n");
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const paths = await locateZcodeCli();
  process.stderr.write(
    `[zcode-runtime] using ZCode CLI at ${paths.cliPath}` +
      (paths.version ? ` (app v${paths.version})` : "") +
      "\n",
  );

  const model = args.model || process.env["ZCODE_MODEL"] || undefined;
  const ctx: MapperContext = {
    paths,
    workspace: args.workspace,
    ...(model ? { model } : {}),
  };

  const acpServer = await startAcpServer(createAcpHandlers(ctx));
  process.stderr.write("[zcode-runtime] ACP server up — awaiting client\n");

  // Stay alive until Multica closes stdin (normal end of Execute) or we get
  // a fatal signal. The CLI is spawned per prompt, not as a long-lived host.
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.stdin.once("end", done);
    process.stdin.once("close", done);
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
  });

  process.stderr.write("[zcode-runtime] shutting down\n");
  await acpServer.close();
}

main().catch((err: unknown) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
