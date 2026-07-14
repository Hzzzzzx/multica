import { api } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { workspaceKeys } from "@multica/core/workspace/queries";
import type { QueryClient } from "@tanstack/react-query";
import {
  LOCAL_MULTICA_API_URL,
  isLocalMulticaHost,
} from "../../../shared/local-multica-endpoints";

const AUTO_LOGIN_TIMEOUT_MS = 8_000;

/**
 * Local Multica auto-login for Desktop (aligned with Android WebView + Beichen MCP).
 *
 * Prefer same-origin apiUrl (Vite proxy → Multica API) so CORS is not required.
 * Fall back to direct LOCAL_MULTICA_API_URL if proxy is dead.
 */
export async function tryLocalDevAutoLogin(options: {
  apiUrl: string;
  queryClient: QueryClient;
}): Promise<boolean> {
  if (!isLocalMulticaHost(options.apiUrl)) return false;

  const candidates = uniqueBases([
    options.apiUrl.replace(/\/+$/, ""),
    LOCAL_MULTICA_API_URL,
  ]);

  let lastError: unknown;
  for (const base of candidates) {
    try {
      const token = await fetchDevLoginToken(base);
      await useAuthStore.getState().loginWithToken(token);
      const wsList = await withTimeout(api.listWorkspaces(), AUTO_LOGIN_TIMEOUT_MS, "listWorkspaces");
      options.queryClient.setQueryData(workspaceKeys.list(), wsList);
      console.info("[desktop] local Multica auto dev-login ok via", base);
      return true;
    } catch (err) {
      lastError = err;
      console.warn("[desktop] auto dev-login failed via", base, err);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchDevLoginToken(base: string): Promise<string> {
  const res = await withTimeout(
    fetch(`${base}/auth/dev-login`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
    }),
    AUTO_LOGIN_TIMEOUT_MS,
    `dev-login ${base}`,
  );
  if (!res.ok) {
    throw new Error(`dev-login HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`dev-login expected JSON, got ${contentType || "unknown"}`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new Error("dev-login response missing token");
  }
  return body.token;
}

function uniqueBases(bases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of bases) {
    if (!b || seen.has(b)) continue;
    seen.add(b);
    out.push(b);
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
