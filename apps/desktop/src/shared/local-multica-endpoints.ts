/**
 * Local Multica endpoints shared by Desktop (Electron) and TianYuan hosts.
 *
 * Use non-default ports so Multica does not collide with other local stacks.
 * Keep Desktop / Web / Android / Beichen MCP pointed at the same API/Web pair.
 */
export const LOCAL_MULTICA_API_PORT = 18480;
export const LOCAL_MULTICA_WEB_PORT = 18430;

export const LOCAL_MULTICA_API_URL = `http://127.0.0.1:${LOCAL_MULTICA_API_PORT}`;
export const LOCAL_MULTICA_WEB_URL = `http://127.0.0.1:${LOCAL_MULTICA_WEB_PORT}`;
export const LOCAL_MULTICA_WS_URL = `ws://127.0.0.1:${LOCAL_MULTICA_API_PORT}/ws`;

/** True when Desktop should auto dev-login (local Multica only). */
export function isLocalMulticaHost(apiUrl: string): boolean {
  try {
    const host = new URL(apiUrl).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Daemon must talk to Multica API directly — not the Electron Vite proxy
 * (5173/5174). Vite is fine for renderer CORS; native daemon WebSocket/HTTP
 * through Vite breaks (timeouts) and makes phone/desktop status diverge.
 */
export function resolveDaemonServerUrl(apiUrl: string): string {
  try {
    const u = new URL(apiUrl.trim());
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    const vitePort = u.port === "5173" || u.port === "5174" || u.port === "3000";
    if (local && vitePort) {
      return LOCAL_MULTICA_API_URL;
    }
    if (local && (!u.port || u.port === "80")) {
      // bare localhost without port — not our Multica API
      return LOCAL_MULTICA_API_URL;
    }
    return apiUrl.replace(/\/+$/, "");
  } catch {
    return LOCAL_MULTICA_API_URL;
  }
}
