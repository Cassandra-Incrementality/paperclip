import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  RunLogRedactionUnavailableError,
  redactKnownSecretValues,
  resetRunLogSecretRedactionCacheForTests,
} from "./run-log-secret-redaction.js";

let tmpDir: string;
let envFile: string;
let previousEnv: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-secret-redaction-test-"));
  envFile = path.join(tmpDir, ".env.ads");
  previousEnv = process.env.RUN_LOG_REDACT_SECRET_FILES;
  process.env.RUN_LOG_REDACT_SECRET_FILES = envFile;
  resetRunLogSecretRedactionCacheForTests();
});

afterEach(async () => {
  if (previousEnv === undefined) delete process.env.RUN_LOG_REDACT_SECRET_FILES;
  else process.env.RUN_LOG_REDACT_SECRET_FILES = previousEnv;
  resetRunLogSecretRedactionCacheForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("redactKnownSecretValues", () => {
  it("substitutes a live credential value pasted into prose, by name", async () => {
    await fs.writeFile(
      envFile,
      [
        'MIXPANEL_PROJECT_TOKEN="abcd1234efgh5678ijkl"',
        "# a comment, ignored",
        "",
      ].join("\n"),
    );
    const text = "✅ Mixpanel token validated — abcd1234efgh5678ijkl returns 1 from Mixpanel's test endpoint.";
    expect(redactKnownSecretValues(text)).toBe(
      "✅ Mixpanel token validated — ***REDACTED:MIXPANEL_PROJECT_TOKEN*** returns 1 from Mixpanel's test endpoint.",
    );
  });

  it("redacts every occurrence, not just the first", async () => {
    await fs.writeFile(envFile, "LINEAR_API_KEY=lin_api_1RVT4nvOArnuaJxLyzwYvYv7QSTrsvASMG2i\n");
    const text = "key=lin_api_1RVT4nvOArnuaJxLyzwYvYv7QSTrsvASMG2i again lin_api_1RVT4nvOArnuaJxLyzwYvYv7QSTrsvASMG2i";
    const redacted = redactKnownSecretValues(text);
    expect(redacted).not.toContain("lin_api_1RVT4nvOArnuaJxLyzwYvYv7QSTrsvASMG2i");
    expect(redacted.match(/\*\*\*REDACTED:LINEAR_API_KEY\*\*\*/g)).toHaveLength(2);
  });

  it("leaves values shorter than the credential floor alone (account ids, flags)", async () => {
    await fs.writeFile(envFile, "META_AD_ACCOUNT_ID=622668819\nSHORT_SECRET=tooshort\n");
    const text = "account 622668819, secret tooshort";
    expect(redactKnownSecretValues(text)).toBe(text);
  });

  it("does not redact a shape word masquerading as a non-secret (PROJECT/URL/ACCOUNT markers)", async () => {
    await fs.writeFile(envFile, "GOOGLE_CLOUD_PROJECT=some-long-project-identifier-name\n");
    const text = "project: some-long-project-identifier-name";
    expect(redactKnownSecretValues(text)).toBe(text);
  });

  it("still redacts a credential word even when a shape word also matches (MIXPANEL_PROJECT_TOKEN)", async () => {
    await fs.writeFile(envFile, "MIXPANEL_PROJECT_TOKEN=abcd1234efgh5678ijkl\n");
    const text = "token abcd1234efgh5678ijkl";
    expect(redactKnownSecretValues(text)).toBe("token ***REDACTED:MIXPANEL_PROJECT_TOKEN***");
  });

  it("treats a public OAuth client id as not secret even though CLIENT_ID is a marker", async () => {
    await fs.writeFile(
      envFile,
      "GOOGLE_ADS_CLIENT_ID=1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com\n",
    );
    const text = "client id 1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com";
    expect(redactKnownSecretValues(text)).toBe(text);
  });

  it("throws RunLogRedactionUnavailableError on first load when the source file is unreadable", () => {
    process.env.RUN_LOG_REDACT_SECRET_FILES = path.join(tmpDir, "does-not-exist.env");
    expect(() => redactKnownSecretValues("anything")).toThrow(RunLogRedactionUnavailableError);
  });

  it("keeps redacting against the last known-good set when a later refresh fails, and logs loudly", async () => {
    await fs.writeFile(envFile, "LINEAR_API_KEY=lin_api_1RVT4nvOArnuaJxLyzwYvYv7QSTrsvASMG2i\n");
    expect(redactKnownSecretValues("lin_api_1RVT4nvOArnuaJxLyzwYvYv7QSTrsvASMG2i")).toContain("REDACTED");

    await fs.rm(envFile);
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.setSystemTime(Date.now() + 61_000); // past the reload interval
      const redacted = redactKnownSecretValues("lin_api_1RVT4nvOArnuaJxLyzwYvYv7QSTrsvASMG2i");
      expect(redacted).toContain("***REDACTED:LINEAR_API_KEY***");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("SECRET REDACTION LOAD FAILED"));
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
