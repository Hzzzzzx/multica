#!/bin/bash
# Manual smoke test for the zcode-runtime ACP shim (CLI backend).
#
# Requires ZCode CLI + ~/.zcode/cli/config.json with a model provider.
# Run: ./test/manual-smoke.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM="$SCRIPT_DIR/../bin/zcode-runtime.mts"

echo "[1/3] --version / --help"
VERSION=$(node "$SHIM" --version)
echo "  version → $VERSION"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "FAIL version"; exit 1; }
node "$SHIM" --help | grep -q "zcode-runtime" || { echo "FAIL help"; exit 1; }
echo "  help ok"

echo "[2/3] ACP initialize + session/new"
WORKSPACE="$(mktemp -d)"
OUT="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -rf "$WORKSPACE" "$OUT" "$ERR" "$OUT2" "$ERR2" 2>/dev/null || true' EXIT

(
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"smoke","version":"0"},"clientCapabilities":{}}}'
  sleep 0.5
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/new\",\"params\":{\"cwd\":\"$WORKSPACE\"}}"
  sleep 1
) | node "$SHIM" --workspace "$WORKSPACE" --stdio >"$OUT" 2>"$ERR" || true

if ! grep -q '"id":1' "$OUT" || ! grep -q '"result"' "$OUT"; then
  echo "FAIL initialize"
  sed 's/^/  out /' "$OUT"; sed 's/^/  err /' "$ERR"
  exit 1
fi
if ! grep -q '"id":2' "$OUT"; then
  echo "FAIL session/new"
  sed 's/^/  out /' "$OUT"; sed 's/^/  err /' "$ERR"
  exit 1
fi
echo "  PASS initialize + session/new"

echo "[3/3] ACP session/prompt (live CLI)"
OUT2="$(mktemp)"
ERR2="$(mktemp)"
python3 - "$SHIM" "$WORKSPACE" "$OUT2" "$ERR2" <<'PY'
import json, subprocess, sys, threading, time, os

shim, workspace, out_path, err_path = sys.argv[1:5]
proc = subprocess.Popen(
    ["node", shim, "--workspace", workspace, "--stdio"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=open(err_path, "w"),
    text=True,
    bufsize=1,
)

def reader():
    assert proc.stdout is not None
    with open(out_path, "w") as f:
        for line in proc.stdout:
            f.write(line)
            f.flush()
            print("  <<", line.rstrip()[:200], flush=True)

t = threading.Thread(target=reader, daemon=True)
t.start()

def send(obj):
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()
    print("  >>", obj.get("method") or obj.get("id"), flush=True)

send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"smoke","version":"0"},"clientCapabilities":{}}})
time.sleep(0.8)
send({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd": workspace}})
time.sleep(0.8)

# parse session id
session_id = "smoke"
deadline = time.time() + 5
while time.time() < deadline:
    if os.path.exists(out_path):
        for line in open(out_path):
            line=line.strip()
            if not line: continue
            try:
                o=json.loads(line)
            except Exception:
                continue
            if o.get("id")==2 and isinstance(o.get("result"), dict):
                session_id = o["result"].get("sessionId") or session_id
                break
        else:
            time.sleep(0.1)
            continue
        break
    time.sleep(0.1)

send({
    "jsonrpc":"2.0","id":3,"method":"session/prompt",
    "params":{
        "sessionId": session_id,
        "prompt":[{"type":"text","text":"Reply with exactly one word: pong"}]
    }
})

# wait for id:3 result up to 120s
ok=False
deadline=time.time()+120
while time.time()<deadline:
    if os.path.exists(out_path):
        body=open(out_path).read()
        if '"id":3' in body and '"result"' in body:
            ok=True
            break
        if "pong" in body.lower():
            ok=True
            break
    time.sleep(0.5)

try:
    proc.stdin.close()
except Exception:
    pass
try:
    proc.wait(timeout=5)
except Exception:
    proc.kill()

body=open(out_path).read() if os.path.exists(out_path) else ""
err=open(err_path).read() if os.path.exists(err_path) else ""
if "pong" in body.lower() or "pong" in err.lower():
    print("  PASS prompt → pong")
    sys.exit(0)
if ok:
    print("  PASS prompt completed (inspect output for content)")
    sys.exit(0)
print("FAIL prompt")
print(body[-2000:])
print(err[-2000:])
sys.exit(1)
PY

echo "All smoke checks passed."
