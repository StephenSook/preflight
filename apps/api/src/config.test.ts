import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applicationPublicKeyPem, loadConfig } from "./config.js";

const base = { VONAGE_API_KEY: "k", VONAGE_SIGNATURE_SECRET: "s", ORIGIN_ANSWER_URL: "https://origin.example/answer" };

describe("applicationPublicKeyPem", () => {
  it("prefers the inline PEM and turns backslash-n into line breaks", () => {
    const inline = "-----BEGIN PUBLIC KEY-----\\nAAAA\\n-----END PUBLIC KEY-----\\n";
    const config = loadConfig({ ...base, VONAGE_APPLICATION_PUBLIC_KEY_PEM: inline, VONAGE_APPLICATION_PUBLIC_KEY_PATH: "/nonexistent/public.key" });
    expect(applicationPublicKeyPem(config)).toBe("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n");
  });

  it("keeps real line breaks in an inline PEM untouched", () => {
    const inline = "-----BEGIN PUBLIC KEY-----\nCCCC\n-----END PUBLIC KEY-----\n";
    expect(applicationPublicKeyPem(loadConfig({ ...base, VONAGE_APPLICATION_PUBLIC_KEY_PEM: inline }))).toBe(inline);
  });

  it("reads the file at the path when no inline PEM is given", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preflight-key-"));
    const file = path.join(dir, "public.key");
    writeFileSync(file, "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----\n");
    expect(applicationPublicKeyPem(loadConfig({ ...base, VONAGE_APPLICATION_PUBLIC_KEY_PATH: file }))).toContain("BBBB");
  });

  it("is undefined when neither is configured", () => {
    expect(applicationPublicKeyPem(loadConfig(base))).toBeUndefined();
  });
});
