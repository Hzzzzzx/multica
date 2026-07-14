# Zcode 适配交接文档

> 面向接手演进的 Agent / 开发者。  
> 最后更新：2026-07-14  
> 仓库：`/Users/hzz/workspace/multica`  
> 分支：`agent/opencode-tianyuan-contract`  
> 提交：`5db1d8ded` — `feat(agent): wire Zcode via official CLI ACP bridge`

---

## 1. 一句话目标

让 Multica 里的 **Zcode Agent** 能像 Codex / Hermes 一样接任务、跑完并回传结果。  
当前第一版闭环已打通：**官方 ZCode CLI headless (`--prompt`) + Multica ACP 桥 (`zcode-runtime`)**。

---

## 2. 用户可见结果（验收事实）

| 项 | 状态 |
|---|---|
| daemon 识别 `zcode` runtime | ✅ health 中含 `zcode` |
| Agent「Zcode」 | ✅ `status=idle`，`model=bigmodel/glm-5.1` |
| Runtime「Zcode (MacBook-Pro.local)」 | ✅ `online` |
| ACP smoke（initialize / session/new / session/prompt） | ✅ 返回 `pong` |
| Multica 真实任务 | ✅ WOR-247「Zcode 适配冒烟」`completed`，输出含 `pong`（约 2 分钟） |

本地身份（本机历史值，换环境请重查 API）：

- workspace_id: `9e41b87a-f6b7-4ed8-86d0-deeb8a26a223`
- agent Zcode: `9f426d86-714e-41b5-b0ba-7e395cb45dbd`
- runtime zcode: `d2a17bd5-97e9-4d02-acd8-88a0a963d24b`

---

## 3. 架构（当前目标态）

```
Multica daemon (Go)
  └─ zcodeBackend (server/pkg/agent/zcode.go)
       └─ spawn: zcode-runtime --workspace <cwd> [--model <id>] --stdio
            │   ACP JSON-RPC 2.0 NDJSON over stdin/stdout
            │   (与 hermesClient 同一套客户端)
            └─ 每个 session/prompt 再 spawn:
                 node …/glm/zcode.cjs --cwd <ws> --mode yolo --prompt <text>
                 （官方 ZCode CLI，非 Electron host）
```

### 为什么不用 Electron host / asar？

早期原型：

1. 解压 `ZCode.app` 的 `app.asar`
2. 用 Node `worker_threads` 跑 `out/host/index.js`
3. 用 `parentPort` 桥接 `init-local` / session 消息

失败原因（ZCode 3.3.5）：

- host 依赖 **Electron `utilityProcess` + `process.parentPort`**，不是 Node `worker_threads`
- `init-local` **必须** 带 transferred `MessagePort`（ChannelServer）；裸 JSON 会被 `if (!ports[0]) return` 直接丢掉
- 跨版本 asar 布局脆弱

官方 headless 面是 CLI：

```text
/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
命令: app-server | --prompt | tui | login | …
版本示例: 0.15.2（随 app 变）
```

注意：`zcode app-server --stdio` 说的是 **ZCode Protocol**，**不是** ACP JSON-RPC（带 `jsonrpc` 字段会被拒）。  
所以 Multica 侧仍用 ACP，shim 内部把 ACP prompt 映射到 CLI `--prompt`。

---

## 4. 关键文件

### 包 `packages/zcode-runtime/`（本目录）

| 路径 | 职责 |
|---|---|
| `bin/zcode-runtime.mts` | CLI 入口；解析 `--workspace` / `--model` / `--stdio` |
| `src/locate-cli.mts` | 发现官方 CLI（env → ZCode.app → PATH `zcode`） |
| `src/cli-runner.mts` | spawn CLI；注入 API key / `ZCODE_MODEL` |
| `src/acp-server.mts` | 最小 ACP server（**必须 unwrap** SDK 的 `{params,client}`） |
| `src/mapper.mts` | session/new、session/prompt → CLI 一轮 |
| `test/manual-smoke.sh` | 手工 smoke |
| `README.md` | 使用说明 |
| `HANDOFF.md` | 本交接文档 |

> **Git 注意**：仓库根 `.gitignore` 有全局 `bin` 规则。`packages/zcode-runtime/bin/*` 需 `git add -f`，否则入口脚本不会进版本库。

### Multica Go

| 路径 | 职责 |
|---|---|
| `server/pkg/agent/zcode.go` | Backend：spawn shim，ACP initialize / session/new / prompt |
| `server/pkg/agent/agent.go` | `New("zcode")`、`launchHeaders` |
| `server/pkg/agent/models.go` | `discoverZcodeModels`：读 app 内 `models_catalog_*.json`，ID 做成 `provider/model` |
| `server/internal/daemon/config.go` | probe `zcode-runtime` / `MULTICA_ZCODE_PATH` |
| `packages/views/runtimes/components/provider-logo.tsx` | UI zcode logo 占位 |

daemon 探测命令名是 **`zcode-runtime`**，不是 `zcode`。

---

## 5. 本机运行依赖（接手必查）

### 5.1 PATH

```bash
# 建议（本机已用过）
~/.local/bin/zcode-runtime → multica/packages/zcode-runtime/bin/zcode-runtime.mts
~/.local/bin/zcode         → /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
```

daemon 进程的 PATH 必须能 `LookPath("zcode-runtime")`。Desktop 拉起的 daemon 一般继承用户 shell PATH；若 Launchpad 冷启动失败，查 PATH。

### 5.2 凭证：`~/.zcode/cli/config.json`

CLI headless **不**自动读桌面 Electron 的 `~/.zcode/v2/`。  
需要 CLI 自己的 config，至少包含：

```json
{
  "provider": {
    "bigmodel": {
      "kind": "anthropic",
      "name": "Bigmodel Coding Plan",
      "options": {
        "apiKeyRequired": true,
        "baseURL": "https://open.bigmodel.cn/api/anthropic",
        "apiKey": "<from desktop or zcode login>"
      },
      "models": { "glm-5.1": { "name": "GLM-5.1" }, "glm-5.2": { "name": "GLM-5.2" } }
    }
  },
  "model": { "main": "bigmodel/glm-5.1", "lite": "bigmodel/glm-4.7" }
}
```

也可：`zcode login`（Coding Plan）。

桌面凭证参考位置（只读对照，勿把密钥写进 git）：

- `~/.zcode/v2/config.json`（`builtin:bigmodel-coding-plan` 等）
- `~/.zcode/v2/credentials.json`

### 5.3 模型与 env 陷阱（重要）

若只设 `ZCODE_MODEL=bigmodel/glm-5.1` **不**带 API key，CLI 会走 env 配置路径并报：

```text
Model provider is missing an API key: bigmodel
envKey: ANTHROPIC_API_KEY
```

`cli-runner.mts` 已处理：从 `~/.zcode/cli/config.json` 读对应 provider 的 `apiKey` / `baseURL`，注入：

- `ANTHROPIC_API_KEY`
- `ZCODE_BASE_URL`（与 `ZCODE_MODEL` 一起时）

模型 ID 格式：**`provider/model`**（如 `bigmodel/glm-5.1`），与 CLI 一致。  
`discoverZcodeModels` 会把 catalog 里的裸 id 加上 provider 前缀。

### 5.4 Multica 服务端口（本机惯例）

| 服务 | 端口 |
|---|---|
| API | `http://127.0.0.1:18480` |
| Web | `18430` |
| Desktop Vite | `127.0.0.1:5173`（daemon 必须连 API 18480，不是 5173） |
| daemon health | `http://127.0.0.1:19514/health` |

改 Go 后需重建并重启 daemon：

```bash
cd server && go build -o ../apps/desktop/resources/bin/multica ./cmd/multica
# 可选同步到 ~/.local/bin/multica
multica daemon restart
```

---

## 6. 协议细节（改 shim 必读）

### ACP SDK handler 形态

`@agentclientprotocol/sdk` ≥0.28 的 handler **第一个参数不是裸 params**，而是：

```ts
{ params: T, client: ... }
```

`acp-server.mts` 里用 `unwrapParams()`。若再直接 `JSON.stringify(raw)` 会撞 circular structure。

### Multica → shim 的 session/new

ACP 要求 `mcpServers` 为 **数组**。`buildZcodeSessionParams` 固定发 `mcpServers: []`。  
ZCode 自己的 MCP 由 CLI / 桌面配置管理，不经 Multica mcp_config 下发（第一版）。

### session/prompt 语义

- 一轮 Multica task ≈ 一次 `zcode --prompt`
- 默认 `--mode yolo`（可用 `MULTICA_ZCODE_MODE` 覆盖）
- 流式：stdout 按行 → ACP `agent_message_chunk`
- CLI 非 0 退出：把 stderr/stdout 写进 transcript，仍 `stopReason: end_turn`（避免整段 ACP 会话硬失败）

### Multica 大 prompt

真实 issue 任务会带 Multica 包装的长 prompt（含 workdir / 规则），不只是用户一句话。  
冒烟 WOR-247 约 866 bytes prompt，ZCode 会读 issue、跑工具，**1～3 分钟**完成是正常现象；不要只按「秒回 pong」判死。

---

## 7. 如何回归

### 7.1 单元/手工（shim）

```bash
cd packages/zcode-runtime
node bin/zcode-runtime.mts --version   # 0.1.0
node bin/zcode-runtime.mts --help
# 完整 ACP + 真模型（需 config）
./test/manual-smoke.sh
# 或直接 CLI
zcode --cwd /tmp --mode yolo --prompt "Reply with exactly one word: pong"
```

### 7.2 Multica 端到端

```bash
curl -sS http://127.0.0.1:19514/health | jq '.agents'   # 含 zcode
multica agent get 9f426d86-714e-41b5-b0ba-7e395cb45dbd  # idle + model
multica issue create \
  --title "Zcode smoke" \
  --description "只回复一个英文单词 pong。" \
  --assignee-id 9f426d86-714e-41b5-b0ba-7e395cb45dbd
# 看 runs / daemon.log
tail -f ~/.multica/daemon.log   # 或 Desktop 日志路径
# Desktop 托管时常见：~/Library/Logs/Multica/agent-daemon.log
```

期望日志片段：

```text
agent version detected name=zcode version=0.1.0 path=zcode-runtime
registered runtime provider=zcode
agent command exec=zcode-runtime args=[--workspace … --model … --stdio]
zcode session created
zcode finished status=completed
```

---

## 8. 环境变量速查

| 变量 | 谁读 | 含义 |
|---|---|---|
| `MULTICA_ZCODE_PATH` | daemon config | 覆盖 `zcode-runtime` 可执行路径 |
| `MULTICA_ZCODE_MODEL` | daemon config probe | 探测时默认模型 env（与其它 provider 一致） |
| `MULTICA_ZCODE_CLI` | shim locate | 官方 CLI 路径（zcode.cjs） |
| `MULTICA_ZCODE_APP` | shim + models.go | ZCode.app 路径 |
| `MULTICA_ZCODE_MODE` | shim cli-runner | 默认 `yolo` |
| `ZCODE_MODEL` | CLI / shim | provider/model；需配合 key 注入 |
| `ANTHROPIC_API_KEY` | CLI（env 路径） | shim 可从 config 注入 |
| `ZCODE_BASE_URL` | CLI | 与 ZCODE_MODEL 一起时用 |

---

## 9. 刻意未做 / 后续演进方向（建议优先级）

按「用户闭环优先、先减法」排序：

### P0 — 稳与可运维

1. **凭证同步自动化**  
   桌面 `~/.zcode/v2` ↔ CLI `~/.zcode/cli/config.json` 仍是手工/一次性脚本。可做 `zcode-runtime doctor` 或 Multica skill：检测缺 key、一键从 v2 同步（勿打印密钥）。

2. **daemon 二进制与 shim 版本一致**  
   Desktop `resources/bin/multica` 需 go build；shim 是 TS 源码直跑。写清「改 Go 必 rebuild + daemon restart」。

3. **失败可观测**  
   CLI `Turn execution failed` 时把 `~/.zcode/cli/log/*.jsonl` 的 cause 摘要到 Multica task error，减少只见 traceId。

### P1 — 能力对齐其它 Agent

4. **流式与工具可视化**  
   当前只转发 CLI stdout 行。ZCode 工具调用在 CLI 日志里，Multica UI 的 tool_call 基本为空。可选：解析 CLI JSON 输出 / 将来接真 ACP 若官方提供。

5. **session/resume**  
   Go 侧已 log「resume 未实现，总是 session/new」。CLI 有 `--resume sess_…` / `-c`。可把 Multica resume_session_id 映射过去。

6. **mcp_config**  
   Multica agent 的 mcp_config 未传给 ZCode。若产品需要，要查 CLI 是否支持 project/mcp 配置注入。

7. **模型列表质量**  
   catalog 含 100+ 模型；默认优先 `bigmodel/` / `zai/`。可按用户已配置 provider 过滤，避免 UI 塞满不可用模型。

### P2 — 协议与形态

8. **官方若提供 ACP**  
   若未来 `zcode acp` 或 app-server 兼容 ACP，可删 shim 内 CLI 映射，daemon 直接 spawn 官方 ACP（对标 hermes/chrys）。

9. **app-server（ZCode Protocol）**  
   若需要长会话/多轮流式，可研究 ZCode Protocol 并在 shim 内桥接；工作量大，仅当 `--prompt` 不够时再上。

10. **勿再走 asar host**  
    除非有人完整实现 Electron utilityProcess 宿主；成本高、版本脆，第一版已否决。

### 非目标（本轮明确不做）

- 企业多租户 / 多用户 ZCode 账号治理  
- 把 ZCode 业务逻辑塞进 Multica foundation  
- 为「以后可能」实现多代凭据、复杂 CAS 等

---

## 10. 相关周边上下文（TianYuan 对话遗留）

本对话前半段还做过（**不一定在本 commit 里**，接手时别和 zcode 搅在一起）：

- 安卓「今日」全给 Multica WebView；额度监控挪到「我的」
- Multica 本地端口对齐 18480/18430、dev-login、Desktop 不走坏代理
- Beichen MCP HTTP 单例
- 清理部分 Multica 定时任务（GitHub 周报 / PR#20 watcher 已删）

TianYuan 主仓：`/Users/hzz/workspace/TianYuan`（规则见 `Agents.md`）。  
Multica 下游 fork 在独立目录；**zcode 代码提交在 multica 仓**，不是 TianYuan 仓。

TianYuan 若要写 skill / 运维说明，可链到：

- 本文件：`multica/packages/zcode-runtime/HANDOFF.md`
- 使用说明：`multica/packages/zcode-runtime/README.md`
- 本地栈：TianYuan `.agents/skills/multica-local-ops`

---

## 11. 接手检查清单（30 分钟）

```text
[ ] git -C multica log -1   # 应看到 5db1d8ded 或其后演进
[ ] which zcode-runtime && zcode-runtime --version
[ ] which zcode && zcode doctor
[ ] test -f ~/.zcode/cli/config.json 且 provider 有 apiKey（勿 cat 进对话）
[ ] curl -s http://127.0.0.1:19514/health | jq .agents   # 含 zcode
[ ] multica agent list | 找 Zcode：idle + model
[ ] 可选：再开一个 1 行 pong issue 派给 Zcode
[ ] 读 HANDOFF §3 §6 §9 后再改协议
```

---

## 12. 提交时注意

- 全局 ignore `bin/` → **`git add -f packages/zcode-runtime/bin/zcode-runtime.mts`**
- 不要提交：`multica.db`、`~/.zcode/**` 密钥、`apps/web/next-env.d.ts` 噪音
- 当前分支可能无 upstream；push 前确认是否应对 `upstream/main` 开 PR 还是仅本地/下游保留

---

## 13. 联系事实摘要（给下一位 Agent 的开场白）

> Zcode 已通过 `zcode-runtime` ACP 桥接官方 CLI `--prompt` 接入 Multica。  
> 不要复活 asar/host worker 方案。  
> 凭证在 `~/.zcode/cli/config.json`；模型 ID 用 `provider/model`。  
> 下一刀优先：凭证同步 doctor、错误可观测、resume、工具流可视化。  
> 细节以 `packages/zcode-runtime/HANDOFF.md` 为准。
