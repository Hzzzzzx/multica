# @multica/zcode-runtime

Multica ↔ ZCode ACP bridge.

Multica's daemon spawns this process and speaks **ACP** (JSON-RPC 2.0 NDJSON)
over stdio. Each `session/prompt` is delegated to the **official ZCode CLI**:

```bash
node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs \
  --cwd <workspace> --mode yolo --prompt <text>
```

## Prerequisites

1. **ZCode.app** installed (default `/Applications/ZCode.app`), or set:
   - `MULTICA_ZCODE_CLI` → path to `zcode.cjs` / `zcode`
   - `MULTICA_ZCODE_APP` → path to `.app` bundle
2. **CLI credentials** in `~/.zcode/cli/config.json`  
   Seed from the desktop app or run `zcode login` (Coding Plan provider).
   Without a provider `apiKey`, prompts fail with `provider_not_configured`.
3. **PATH**: `zcode-runtime` must resolve (this package's `bin/`, or
   `~/.local/bin/zcode-runtime` symlink).

## Usage

```bash
zcode-runtime --workspace /path/to/project [--model bigmodel/glm-5.1] --stdio
```

Env:

| Variable | Meaning |
|---|---|
| `MULTICA_ZCODE_CLI` | Explicit CLI path |
| `MULTICA_ZCODE_APP` | ZCode.app bundle path |
| `MULTICA_ZCODE_MODE` | Permission mode (default `yolo`) |
| `ZCODE_MODEL` | Fallback model when `--model` omitted |

When `--model` / `ZCODE_MODEL` is set, the shim injects `ANTHROPIC_API_KEY`
(and `ZCODE_BASE_URL`) from `~/.zcode/cli/config.json` so the CLI env-config
path still works.

## Smoke

```bash
./test/manual-smoke.sh
# or
node bin/zcode-runtime.mts --version
```

## Why not Electron host?

Earlier prototypes extracted `app.asar` and spawned `out/host/index.js` as a
`worker_threads` process. ZCode host expects Electron `utilityProcess` +
`process.parentPort` + transferred `MessagePort` for `init-local`. That path
is fragile across ZCode versions. The official CLI is the supported headless
surface.
