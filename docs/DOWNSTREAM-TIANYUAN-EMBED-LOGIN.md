# Downstream only — TianYuan Android embed login

**禁止把下列登录/嵌入相关修改推送到上游主仓库 `multica-ai/multica`（upstream/main）。**

这些是 TianYuan 本地/下游定制，仅用于 Android「今日」WebView 嵌入 Multica 看板。

## 涉及文件

| 文件 | 用途 |
|------|------|
| `packages/core/platform/auth-initializer.tsx` | 识别 `TianYuanAndroidMultica` UA；dev 自动登录；`window.__tianyuanSeedSession` |
| `server/internal/handler/auth.go` | `DevAutoLogin` 默认跳转 `/workspace/issues`；写 `last_workspace_slug` |
| `apps/web/proxy.ts` | 未登录访问 `/` 进 `/login`（去掉 dev 强制跳过登录页） |

## 允许

- 提交到本机 fork / 下游分支（如 `agent/opencode-tianyuan-contract`、`origin` 上的 TianYuan 分支）
- 在 TianYuan 侧文档中引用

## 禁止

- `git push upstream …` 把上述 diff 并入 `upstream/main`
- 向上游开 PR 时夹带这些补丁（除非上游明确要通用的 embed 能力，并单独评审）

## 上游若需要类似能力

应改成可配置、无 TianYuan 品牌硬编码的方案后再贡献，而不是直接推本文件中的硬编码路径。
