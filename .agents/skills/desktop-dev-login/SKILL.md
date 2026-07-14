---
name: desktop-dev-login
description: >-
  Fix Electron Multica Desktop local login (spinner, Failed to fetch, stuck on
  login). Use when desktop dev won't auto-login, /auth/dev-login 502, or after
  port/proxy changes. Ports: API 18480, Web 18430, Vite 5173.
metadata:
  author: hzz
  version: "2.0.0"
---

# Desktop Dev-Mode Login (TianYuan local)

**Downstream only — do not push login/port patches to upstream `multica-ai/multica` main.**  
See `docs/DOWNSTREAM-TIANYUAN-EMBED-LOGIN.md`.

## Port contract

| Service | URL |
|---|---|
| Multica API | `http://127.0.0.1:18480` |
| Multica Web | `http://127.0.0.1:18430` |
| Desktop Vite | `http://127.0.0.1:5173` |

Prefer **TianYuan** control scripts:

```bash
cd /Users/hzz/workspace/TianYuan
bash scripts/multica/stack-ctl.sh status
bash scripts/multica/desktop-ctl.sh restart
```

Or skill `multica-local-ops` in TianYuan.

## Symptoms

- Desktop only shows Multica icon spinning
- Renderer: `Failed to fetch` on `/auth/dev-login`
- `curl` to Vite auth returns **502**

## Root causes (ordered)

1. **Stale electron-vite** still proxying to dead **8080** → restart Desktop.
2. **System HTTP proxy** (Clash etc.) hijacks `localhost` / `[::1]` → 502.  
   Use `127.0.0.1`, `NO_PROXY=localhost,127.0.0.1`, and Electron `proxy-bypass-list`.
3. Multica API down → start stack first.
4. Cross-origin: renderer must use Vite origin (`127.0.0.1:5173`) so `/api` `/auth` proxy to 18480 (same-origin).

## Expected code (already in this branch)

- `apps/desktop/src/shared/local-multica-endpoints.ts` — 18480/18430
- `electron.vite.config.ts` — `host: 127.0.0.1`, proxy → 18480
- `src/main/index.ts` — dev `apiUrl` → `http://127.0.0.1:5173`, proxy bypass
- `src/renderer/.../local-dev-auto-login.ts` + `App.tsx` — auto dev-login on local host

## Diagnose (always `--noproxy`)

```bash
curl -sS --noproxy '*' -o /dev/null -w 'api:%{http_code}\n' http://127.0.0.1:18480/health
curl -sS --noproxy '*' -H 'Accept: application/json' -o /dev/null -w 'dev-login:%{http_code}\n' \
  http://127.0.0.1:18480/auth/dev-login
curl -sS --noproxy '*' -H 'Accept: application/json' -o /dev/null -w 'vite-auth:%{http_code}\n' \
  http://127.0.0.1:5173/auth/dev-login
```

Want all **200**.

## Restart Desktop

```bash
cd /Users/hzz/workspace/TianYuan
bash scripts/multica/desktop-ctl.sh restart
# or
cd ~/workspace/multica/apps/desktop
# kill old vite on 5173, then:
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  NO_PROXY=localhost,127.0.0.1,::1 pnpm dev
```

## Do not

- Point Desktop at cloud `api.multica.ai` for local TianYuan work
- Use ports **8080/3000** for this machine’s Multica
- `git push upstream` of these embed/login patches
