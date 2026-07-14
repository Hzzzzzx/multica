import {
  LOCAL_MULTICA_API_URL,
  LOCAL_MULTICA_WEB_URL,
  LOCAL_MULTICA_WS_URL,
} from "./local-multica-endpoints";

export interface RuntimeConfig {
  schemaVersion: 1;
  apiUrl: string;
  wsUrl: string;
  appUrl: string;
}

export interface RuntimeConfigError {
  message: string;
}

export type RuntimeConfigResult =
  | { ok: true; config: RuntimeConfig }
  | { ok: false; error: RuntimeConfigError };

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = Object.freeze({
  schemaVersion: 1,
  apiUrl: "https://api.multica.ai",
  wsUrl: "wss://api.multica.ai/ws",
  appUrl: "https://multica.ai",
});

/** Local self-host defaults — aligned with TianYuan Multica (18480/18430). */
const LOCAL_DEV_RUNTIME_CONFIG: RuntimeConfig = Object.freeze({
  schemaVersion: 1,
  apiUrl: LOCAL_MULTICA_API_URL,
  wsUrl: LOCAL_MULTICA_WS_URL,
  appUrl: LOCAL_MULTICA_WEB_URL,
});

export interface RuntimeConfigEnv {
  apiUrl?: string;
  wsUrl?: string;
  appUrl?: string;
}

export function runtimeConfigFromDevEnv(env: RuntimeConfigEnv): RuntimeConfig {
  const apiUrl = normalizeHttpUrl(
    env.apiUrl || LOCAL_DEV_RUNTIME_CONFIG.apiUrl,
    "VITE_API_URL",
  );
  return {
    schemaVersion: 1,
    apiUrl,
    wsUrl: env.wsUrl
      ? normalizeWsUrl(env.wsUrl, "VITE_WS_URL")
      : deriveWsUrl(apiUrl),
    appUrl: env.appUrl
      ? normalizeHttpUrl(env.appUrl, "VITE_APP_URL")
      : deriveDevAppUrl(apiUrl),
  };
}

export function parseRuntimeConfig(raw: string): RuntimeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid desktop runtime config JSON: ${err instanceof Error ? err.message : "parse failed"}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid desktop runtime config: expected a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new Error("Unsupported desktop runtime config schemaVersion: expected 1");
  }

  const apiUrl = requiredString(obj.apiUrl, "apiUrl");
  const appUrl = optionalString(obj.appUrl, "appUrl");
  const wsUrl = optionalString(obj.wsUrl, "wsUrl");

  const normalizedApiUrl = normalizeHttpUrl(apiUrl, "apiUrl");
  return {
    schemaVersion: 1,
    apiUrl: normalizedApiUrl,
    wsUrl: wsUrl ? normalizeWsUrl(wsUrl, "wsUrl") : deriveWsUrl(normalizedApiUrl),
    appUrl: appUrl ? normalizeHttpUrl(appUrl, "appUrl") : deriveAppUrl(normalizedApiUrl),
  };
}

export function deriveWsUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error("apiUrl must use http or https");
  url.pathname = joinPath(url.pathname, "/ws");
  url.search = "";
  url.hash = "";
  return trimTrailingSlash(url.toString());
}

// Convention: api hosts are exposed at `api.<web-host>` (api.multica.ai →
// multica.ai, api.test.multica.ai → test.multica.ai). Strip the leading
// `api.` label so a single `apiUrl` configuration produces the right
// shareable web URL. Hosts that don't match the convention (no leading
// `api.` label, or short two-label hosts like `api.local`) fall through
// untouched — those deployments must set `appUrl` explicitly.
export function deriveAppUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  if (url.hostname.startsWith("api.") && url.hostname.split(".").length >= 3) {
    url.hostname = url.hostname.slice("api.".length);
  }
  return trimTrailingSlash(url.toString());
}

// Dev variant: when the api host is the local backend (`127.0.0.1:18480` /
// `localhost:18480`), the web UI is on FRONTEND_PORT (18430), so deriving
// by host alone is wrong. Fall back to the local Multica web URL in that
// case; for any non-local host (e.g. a remote test environment), trust the
// production-style derivation so `apiUrl=https://api.test.x` yields
// `appUrl=https://test.x` without a separate VITE_APP_URL.
export function deriveDevAppUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return LOCAL_DEV_RUNTIME_CONFIG.appUrl;
  }
  return deriveAppUrl(apiUrl);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid desktop runtime config: ${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid desktop runtime config: ${field} must be a non-empty string when set`);
  }
  return value;
}

function normalizeHttpUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid desktop runtime config: ${field} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid desktop runtime config: ${field} must use http or https`);
  }
  url.search = "";
  url.hash = "";
  return trimTrailingSlash(url.toString());
}

function normalizeWsUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid desktop runtime config: ${field} must be a valid URL`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Invalid desktop runtime config: ${field} must use ws or wss`);
  }
  url.search = "";
  url.hash = "";
  return trimTrailingSlash(url.toString());
}

function joinPath(base: string, suffix: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${normalizedBase}${suffix}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
