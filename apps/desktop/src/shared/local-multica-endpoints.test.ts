import { describe, expect, it } from "vitest";
import {
  LOCAL_MULTICA_API_URL,
  LOCAL_MULTICA_WEB_URL,
  isLocalMulticaHost,
} from "./local-multica-endpoints";

describe("local Multica endpoints", () => {
  it("uses TianYuan-aligned ports", () => {
    expect(LOCAL_MULTICA_API_URL).toBe("http://127.0.0.1:18480");
    expect(LOCAL_MULTICA_WEB_URL).toBe("http://127.0.0.1:18430");
  });

  it("detects local hosts for auto dev-login", () => {
    expect(isLocalMulticaHost("http://127.0.0.1:18480")).toBe(true);
    expect(isLocalMulticaHost("http://localhost:5173")).toBe(true);
    expect(isLocalMulticaHost("https://api.multica.ai")).toBe(false);
  });
});
