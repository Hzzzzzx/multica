# Downstream only — TianYuan Multica embed / local ports

**禁止把下列登录/嵌入/本机端口相关修改推送到上游主仓库 `multica-ai/multica`（upstream/main）。**

这些是 TianYuan 本地/下游定制，让 Android WebView、Desktop、Beichen MCP **对齐同一套本机 Multica**：

| 服务 | 端口 |
|------|------|
| API | `127.0.0.1:18480` |
| Web | `127.0.0.1:18430` |

本地自动登录统一走 `GET /auth/dev-login`（`Accept: application/json`）→ `dev@multica.local`。

## 涉及文件

| 文件 | 用途 |
|------|------|
| `packages/core/platform/auth-initializer.tsx` | 识别 `TianYuanAndroidMultica` UA；dev 自动登录；`window.__tianyuanSeedSession` |
| `server/internal/handler/auth.go` | `DevAutoLogin` 默认跳转 `/workspace/issues`；写 `last_workspace_slug` |
| `apps/web/proxy.ts` | 未登录访问 `/` 进 `/login`（去掉 dev 强制跳过登录页） |
| `apps/desktop/src/shared/local-multica-endpoints.ts` | Desktop 本机 API/Web 端口常量（18480/18430） |
| `apps/desktop/electron.vite.config.ts` | dev 代理 `/api` `/auth` `/ws` → `:18480` |
| `apps/desktop/src/shared/runtime-config.ts` | 本地默认 runtime 指向 18480/18430 |
| `apps/desktop/src/renderer/src/platform/local-dev-auto-login.ts` | Desktop 本机自动 dev-login |
| `apps/desktop/src/renderer/src/App.tsx` | 启动时对本机 API 调用 auto-login |

## 允许

- 提交到本机 fork / 下游分支（如 `agent/opencode-tianyuan-contract`、`origin` 上的 TianYuan 分支）
- 在 TianYuan 侧文档中引用

## 禁止

- `git push upstream …` 把上述 diff 并入 `upstream/main`
- 向上游开 PR 时夹带这些补丁（除非上游明确要通用的 embed 能力，并单独评审）

## 上游若需要类似能力

应改成可配置、无 TianYuan 品牌硬编码的方案后再贡献，而不是直接推本文件中的硬编码路径。
