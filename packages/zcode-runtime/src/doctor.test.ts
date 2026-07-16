import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor, syncDesktopCredential } from "./doctor.mts";

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("syncDesktopCredential", () => {
  it("copies only the enabled credential and preserves CLI settings", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-doctor-"));
    temporaryHomes.push(home);
    const desktopDir = path.join(home, ".zcode", "v2");
    const cliDir = path.join(home, ".zcode", "cli");
    await fs.mkdir(desktopDir, { recursive: true });
    await fs.mkdir(cliDir, { recursive: true });
    await fs.writeFile(
      path.join(desktopDir, "config.json"),
      JSON.stringify({
        provider: {
          "builtin:bigmodel-start-plan": {
            enabled: false,
            options: { apiKey: "disabled-secret", baseURL: "https://disabled.invalid" },
          },
          "builtin:bigmodel-coding-plan": {
            enabled: true,
            kind: "anthropic",
            name: "Bigmodel Coding Plan",
            options: { apiKey: "enabled-secret", baseURL: "https://example.invalid" },
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(cliDir, "config.json"),
      JSON.stringify({
        theme: "dark",
        provider: { bigmodel: { models: { "glm-5.1": { name: "GLM-5.1" } } } },
      }),
    );

    const result = await syncDesktopCredential(home);
    const cli = JSON.parse(
      await fs.readFile(path.join(cliDir, "config.json"), "utf8"),
    ) as {
      theme: string;
      provider: Record<string, { options: { apiKey: string }; models: unknown }>;
    };

    expect(result.sourceProvider).toBe("builtin:bigmodel-coding-plan");
    expect(result.targetProvider).toBe("bigmodel");
    expect(cli.theme).toBe("dark");
    expect(cli.provider["bigmodel"]?.models).toEqual({
      "glm-5.1": { name: "GLM-5.1" },
    });
    expect(cli.provider["bigmodel"]?.options.apiKey).toBe("enabled-secret");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(cliDir, "config.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("does not echo malformed credential config contents", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-doctor-"));
    temporaryHomes.push(home);
    const cliDir = path.join(home, ".zcode", "cli");
    await fs.mkdir(cliDir, { recursive: true });
    await fs.writeFile(
      path.join(cliDir, "config.json"),
      '{"provider":"do-not-print-this-secret"',
    );

    const result = await runDoctor({ sync: false, homeDir: home });
    const output = result.lines.join("\n");

    expect(output).toContain("contains invalid JSON");
    expect(output).not.toContain("do-not-print-this-secret");
  });
});
