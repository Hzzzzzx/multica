// ACP handlers that drive the official ZCode CLI for each session/prompt.
//
// One Multica prompt = one `zcode --prompt` invocation. This matches how
// Multica tasks are scoped (single turn of work) and avoids reverse-
// engineering ZCode's Electron host parentPort protocol.

import { randomUUID } from "node:crypto";
import type { AcpServerOptions } from "./acp-server.mts";
import type { ZcodeCliPaths } from "./locate-cli.mts";
import { runZcodePrompt } from "./cli-runner.mts";

export interface MapperContext {
  paths: ZcodeCliPaths;
  workspace: string;
  model?: string;
}

interface PromptParams {
  sessionId: string;
  prompt: Array<{ type: string; text?: string }>;
}

interface SessionState {
  id: string;
  abort?: AbortController;
}

const sessions = new Map<string, SessionState>();

export function createAcpHandlers(ctx: MapperContext): AcpServerOptions {
  return {
    onNewSession: async (params) => {
      const p = (params ?? {}) as { cwd?: string; model?: string };
      const id = randomUUID();
      sessions.set(id, { id });
      if (typeof p.cwd === "string" && p.cwd.length > 0) {
        // Prefer session cwd if Multica passes one; fall back to CLI flag.
        (ctx as { workspace: string }).workspace = p.cwd;
      }
      if (typeof p.model === "string" && p.model.length > 0) {
        (ctx as { model?: string }).model = p.model;
      }
      process.stderr.write(
        `[zcode-runtime] session/new → ${id} workspace=${ctx.workspace}` +
          (ctx.model ? ` model=${ctx.model}` : "") +
          "\n",
      );
      return {
        sessionId: id,
        // Advertise current model so Multica can record usage keys.
        ...(ctx.model
          ? {
              models: {
                currentModelId: ctx.model,
                availableModels: [{ modelId: ctx.model, name: ctx.model }],
              },
            }
          : {}),
      };
    },

    onPrompt: async (params, sendUpdate) => {
      const p = params as PromptParams;
      const text = (p.prompt ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");

      const session = sessions.get(p.sessionId) ?? { id: p.sessionId };
      if (session.abort) {
        try {
          session.abort.abort();
        } catch {
          // ignore
        }
      }
      const abort = new AbortController();
      session.abort = abort;
      sessions.set(p.sessionId, session);

      process.stderr.write(
        `[zcode-runtime] session/prompt session=${p.sessionId} chars=${text.length}\n`,
      );

      let streamed = "";
      try {
        const result = await runZcodePrompt({
          paths: ctx.paths,
          workspace: ctx.workspace,
          prompt: text,
          model: ctx.model,
          signal: abort.signal,
          onStdoutLine: (line) => {
            // Stream each stdout line as an agent message chunk so Multica
            // UI can show progress while the CLI runs.
            const chunk = line.length > 0 ? `${line}\n` : "\n";
            streamed += chunk;
            void sendUpdate({
              sessionId: p.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: chunk },
              },
            });
          },
          onStderrLine: (line) => {
            process.stderr.write(`[zcode-cli] ${line}\n`);
          },
        });

        if (abort.signal.aborted) {
          return { stopReason: "cancelled" as const };
        }

        if (result.code !== 0) {
          const errText =
            result.stderr.trim() ||
            result.stdout.trim() ||
            `zcode exited with code ${result.code}`;
          // If we never streamed anything, surface the error as a message.
          if (!streamed.trim()) {
            await sendUpdate({
              sessionId: p.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: errText },
              },
            });
          }
          process.stderr.write(
            `[zcode-runtime] CLI failed code=${result.code} signal=${result.signal}\n`,
          );
          // Still end_turn — Multica's hermesClient treats RPC errors as
          // hard failures; putting the CLI error in the transcript is more
          // useful than killing the whole ACP session.
          return { stopReason: "end_turn" as const };
        }

        // If CLI printed nothing line-buffered, flush full stdout once.
        if (!streamed.trim() && result.stdout.trim()) {
          await sendUpdate({
            sessionId: p.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: result.stdout },
            },
          });
        }

        return { stopReason: "end_turn" as const };
      } catch (err) {
        if (abort.signal.aborted) {
          return { stopReason: "cancelled" as const };
        }
        const msg = err instanceof Error ? err.message : String(err);
        await sendUpdate({
          sessionId: p.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `zcode-runtime error: ${msg}` },
          },
        });
        return { stopReason: "end_turn" as const };
      } finally {
        if (sessions.get(p.sessionId)?.abort === abort) {
          session.abort = undefined;
        }
      }
    },

    onCancel: async (params) => {
      const p = (params ?? {}) as { sessionId?: string };
      if (p.sessionId) {
        const s = sessions.get(p.sessionId);
        s?.abort?.abort();
        process.stderr.write(
          `[zcode-runtime] session/cancel session=${p.sessionId}\n`,
        );
      }
      return {};
    },

    onListSessions: async () => ({
      sessions: [...sessions.keys()].map((sessionId) => ({ sessionId })),
    }),
  };
}
