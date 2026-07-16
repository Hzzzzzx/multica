import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { locateZcodeCli } from "./locate-cli.mts";

type JsonObject = Record<string, unknown>;

export interface DoctorResult {
  ok: boolean;
  lines: string[];
}

export interface SyncResult {
  sourceProvider: string;
  targetProvider: string;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
  const raw = await fs.readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${filePath} contains invalid JSON`);
  }
  const object = asObject(parsed);
  if (!object) throw new Error(`${filePath} must contain a JSON object`);
  return object;
}

function providerTargetId(sourceId: string): string {
  const withoutBuiltin = sourceId.replace(/^builtin:/, "");
  return withoutBuiltin.replace(/-(?:coding|start)-plan$/, "");
}

function findDesktopCredential(config: JsonObject): {
  id: string;
  provider: JsonObject;
  apiKey: string;
} {
  const providers = asObject(config["provider"]);
  if (!providers) throw new Error("desktop config has no provider object");

  const candidates = Object.entries(providers).flatMap(([id, value]) => {
    const provider = asObject(value);
    const options = asObject(provider?.["options"]);
    const apiKey = options?.["apiKey"];
    if (!provider || typeof apiKey !== "string" || apiKey.trim() === "") {
      return [];
    }
    return [{ id, provider, apiKey: apiKey.trim() }];
  });
  const credential = candidates.find(({ provider }) => provider["enabled"] === true);
  if (!credential) {
    throw new Error("desktop config has no enabled provider with an API key");
  }
  return credential;
}

async function writeCredentialConfig(
  configPath: string,
  config: JsonObject,
): Promise<void> {
  const directory = path.dirname(configPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.config.json.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(tempPath, configPath);
    await fs.chmod(configPath, 0o600);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function syncDesktopCredential(
  homeDir = os.homedir(),
): Promise<SyncResult> {
  const desktopPath = path.join(homeDir, ".zcode", "v2", "config.json");
  const cliPath = path.join(homeDir, ".zcode", "cli", "config.json");
  const desktop = await readJsonObject(desktopPath);
  const source = findDesktopCredential(desktop);
  const targetProvider = providerTargetId(source.id);
  if (!targetProvider) throw new Error(`unsupported desktop provider: ${source.id}`);

  let cli: JsonObject = {};
  try {
    cli = await readJsonObject(cliPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const providers = asObject(cli["provider"]) ?? {};
  const existingProvider = asObject(providers[targetProvider]) ?? {};
  const existingOptions = asObject(existingProvider["options"]) ?? {};
  const sourceOptions = asObject(source.provider["options"]) ?? {};
  const nextOptions: JsonObject = {
    ...existingOptions,
    apiKey: source.apiKey,
  };
  if (typeof sourceOptions["baseURL"] === "string") {
    nextOptions["baseURL"] = sourceOptions["baseURL"];
  }

  const nextProvider: JsonObject = {
    ...existingProvider,
    options: nextOptions,
  };
  if (typeof source.provider["kind"] === "string") {
    nextProvider["kind"] = source.provider["kind"];
  }
  if (typeof source.provider["name"] === "string") {
    nextProvider["name"] = source.provider["name"];
  }

  providers[targetProvider] = nextProvider;
  cli["provider"] = providers;
  await writeCredentialConfig(cliPath, cli);
  return { sourceProvider: source.id, targetProvider };
}

async function inspectCliCredentials(homeDir: string): Promise<{
  ready: boolean;
  providerIds: string[];
}> {
  const configPath = path.join(homeDir, ".zcode", "cli", "config.json");
  const config = await readJsonObject(configPath);
  const providers = asObject(config["provider"]) ?? {};
  const providerIds = Object.entries(providers).flatMap(([id, value]) => {
    const options = asObject(asObject(value)?.["options"]);
    const apiKey = options?.["apiKey"];
    return typeof apiKey === "string" && apiKey.trim() !== "" ? [id] : [];
  });
  return { ready: providerIds.length > 0, providerIds };
}

export async function runDoctor(options: {
  sync: boolean;
  homeDir?: string;
}): Promise<DoctorResult> {
  const homeDir = options.homeDir ?? os.homedir();
  const lines = ["zcode-runtime doctor"];
  let cliReady = false;
  let syncReady = true;
  try {
    const cli = await locateZcodeCli();
    lines.push(
      `[ok] ZCode CLI: ${cli.cliPath}${cli.version ? ` (app v${cli.version})` : ""}`,
    );
    cliReady = true;
  } catch (error) {
    lines.push(`[fail] ZCode CLI: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (options.sync) {
    try {
      const synced = await syncDesktopCredential(homeDir);
      lines.push(
        `[ok] Credentials synced: ${synced.sourceProvider} -> ${synced.targetProvider}`,
      );
    } catch (error) {
      syncReady = false;
      lines.push(
        `[fail] Credential sync: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    const credentials = await inspectCliCredentials(homeDir);
    if (credentials.ready) {
      lines.push(`[ok] CLI credentials: ${credentials.providerIds.join(", ")}`);
      return { ok: cliReady && syncReady, lines };
    }
    lines.push(`[fail] CLI credentials: no provider has an API key`);
  } catch (error) {
    lines.push(
      `[fail] CLI credentials: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!options.sync) {
    lines.push("hint: run `zcode-runtime doctor --sync` or `zcode login`");
  }
  return { ok: false, lines };
}
