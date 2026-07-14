// Minimal ACP stdio server for the ZCode CLI bridge.
//
// Implements: initialize, authenticate, session/new, session/prompt,
// session/cancel, session/list. Matches the surface Multica's hermesClient
// uses against Hermes/Chrys ACP backends.
//
// Note: @agentclientprotocol/sdk >=0.28 passes handlers a bag
// `{ params, client }` rather than bare params. We unwrap here so mapper
// code can stay protocol-shaped.

import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

export interface AcpServerOptions {
  onNewSession?: (params: unknown) => Promise<unknown>;
  onPrompt?: (
    params: unknown,
    sendUpdate: (notification: unknown) => Promise<void>,
  ) => Promise<unknown>;
  onCancel?: (params: unknown) => Promise<unknown>;
  onListSessions?: (params: unknown) => Promise<unknown>;
}

export interface AcpServer {
  sendSessionUpdate(notification: unknown): Promise<void>;
  requestPermission(request: unknown): Promise<unknown>;
  close(): Promise<void>;
}

type ClientCtx = {
  notify: (method: string, params: unknown) => Promise<void>;
  request: (method: string, params: unknown) => Promise<unknown>;
};

/** Unwrap SDK handler bag `{ params, client }` → bare params. */
function unwrapParams(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "params" in (raw as object)) {
    return (raw as { params: unknown }).params;
  }
  return raw;
}

export async function startAcpServer(opts: AcpServerOptions): Promise<AcpServer> {
  const app = acp.agent();
  let clientCtx: ClientCtx | null = null;

  app.onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: {
      name: "zcode-runtime",
      version: "0.1.0",
    },
  }));
  app.onRequest(acp.methods.agent.authenticate, async () => ({}));

  if (opts.onNewSession) {
    const h = opts.onNewSession;
    app.onRequest(
      acp.methods.agent.session.new,
      (async (raw: unknown) => h(unwrapParams(raw))) as never,
    );
  }
  if (opts.onListSessions) {
    const h = opts.onListSessions;
    app.onRequest(
      acp.methods.agent.session.list,
      (async (raw: unknown) => h(unwrapParams(raw))) as never,
    );
  }
  if (opts.onCancel) {
    const h = opts.onCancel;
    app.onNotification(
      acp.methods.agent.session.cancel,
      (async (raw: unknown) => h(unwrapParams(raw))) as never,
    );
  }
  if (opts.onPrompt) {
    const h = opts.onPrompt;
    app.onRequest(
      acp.methods.agent.session.prompt,
      (async (raw: unknown) => {
        const params = unwrapParams(raw);
        const sendUpdate = async (n: unknown): Promise<void> => {
          if (!clientCtx) {
            process.stderr.write(
              "[zcode-runtime] drop session/update: client not connected\n",
            );
            return;
          }
          await clientCtx.notify(acp.methods.client.session.update, n);
        };
        return h(params, sendUpdate);
      }) as never,
    );
  }

  const output = Writable.toWeb(process.stdout) as unknown as WritableStream;
  const input = Readable.toWeb(process.stdin!) as unknown as ReadableStream;
  const stream = acp.ndJsonStream(output, input);

  const connection = app.connect(stream);
  clientCtx = (
    connection as unknown as {
      client: ClientCtx;
    }
  ).client;

  return {
    sendSessionUpdate: async (notification: unknown): Promise<void> => {
      if (!clientCtx) return;
      await clientCtx.notify(acp.methods.client.session.update, notification);
    },
    requestPermission: async (request: unknown): Promise<unknown> => {
      if (!clientCtx) throw new Error("client not connected");
      return clientCtx.request(
        acp.methods.client.session.requestPermission,
        request,
      );
    },
    close: async (): Promise<void> => {
      (process.stdout as unknown as { end: () => void }).end?.();
    },
  };
}
