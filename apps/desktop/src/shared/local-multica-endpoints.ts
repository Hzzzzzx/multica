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
