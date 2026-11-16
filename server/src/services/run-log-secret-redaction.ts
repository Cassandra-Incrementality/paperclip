import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Redact-on-write for the run-log writer (PPC-7681 / PPC-7676). Agents paste
// live credential VALUES into their own stdout/stderr prose -- not just into
// structured `token: "..."` fields, which `redaction.ts`'s shape-based
// `redactSensitiveText` already covers -- so the only reliable catch is an
// exact-value cross-reference against the authoritative source, the same
// approach `scripts/secret_value_scan.py` uses to MEASURE the leak. This
// module is the mechanical fix at the single append() choke point so no
// agent discipline fix is required (30 agents already crossed that line).
//
// Classification constants below are kept byte-for-byte in sync with
// secret_value_scan.py's `is_secret_var` / `MIN_VALUE_LEN`: the writer and the
// scanner that verifies the sweep must agree on what counts as a credential,
// or the scanner's baseline can never ratchet to zero.

const MIN_VALUE_LEN = 20;

const NOT_SECRET_MARKERS = [
  "PROJECT", "URL", "URI", "REGION", "PROXY", "CREDENTIALS",
  "PROVIDERS", "ACCOUNT", "CHANNEL", "SHEET",
] as const;
const SECRET_MARKERS = ["SECRET", "TOKEN", "KEY", "PASSWORD", "CLIENT_ID"] as const;
const STRONG_SECRET_MARKERS = ["SECRET", "TOKEN", "PASSWORD", "API_KEY", "PRIVATE_KEY"] as const;
const PUBLIC_ID_NAME_SUFFIXES = ["_OAUTH_CLIENT_ID", "_WEB_CLIENT_ID"] as const;
const PUBLIC_ID_VALUE_SUFFIXES = [".apps.googleusercontent.com"] as const;

function isPublicIdentifier(name: string, value: string): boolean {
  const upper = name.toUpperCase();
  if (PUBLIC_ID_NAME_SUFFIXES.some((suffix) => upper.endsWith(suffix))) return true;
  return Boolean(value) && PUBLIC_ID_VALUE_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

function isSecretVar(name: string, value: string): boolean {
  const upper = name.toUpperCase();
  if (isPublicIdentifier(name, value)) return false;
  if (STRONG_SECRET_MARKERS.some((marker) => upper.includes(marker))) return true;
  if (NOT_SECRET_MARKERS.some((marker) => upper.includes(marker))) return false;
  if (upper.endsWith("_ID") && !["KEY", "SECRET", "CLIENT_ID"].some((marker) => upper.includes(marker))) {
    return false;
  }
  return SECRET_MARKERS.some((marker) => upper.includes(marker));
}

function parseEnvAdsValues(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of contents.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eqIndex = line.indexOf("=");
    let key = line.slice(0, eqIndex).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    const value = line.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (value.length >= MIN_VALUE_LEN && isSecretVar(key, value)) {
      values.set(key, value);
    }
  }
  return values;
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function resolveSourceFiles(): string[] {
  const raw = process.env.RUN_LOG_REDACT_SECRET_FILES?.trim();
  if (raw) {
    return raw.split(",").map((entry) => expandHome(entry.trim())).filter(Boolean);
  }
  // Default to this deployment's known credential file. Overridable above for
  // other instances/tests; intentionally NOT optional-by-default -- an unset
  // var must mean "use the known default", never "redaction is off", so a
  // misconfigured env can't silently disable this guard by omission.
  return [path.resolve(os.homedir(), ".openclaw", "workspace", ".env.ads")];
}

export class RunLogRedactionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLogRedactionUnavailableError";
  }
}

interface LoadedSecrets {
  // Longest-first so a value that is a substring of another (unlikely, but
  // never assumed) is still redacted under its own, more specific marker
  // first.
  entriesByLengthDesc: Array<{ name: string; value: string }>;
  loadedAt: number;
}

// Re-read periodically (not on every append) so a rotation in .env.ads is
// picked up without a server restart, and a single transient read failure
// doesn't retry on every one of thousands of appends in a run.
const RELOAD_INTERVAL_MS = 60_000;
const FAILURE_LOG_THROTTLE_MS = 30_000;

let lastGood: LoadedSecrets | null = null;
let lastAttemptAt = 0;
let lastFailureLoggedAt = 0;

function loadSecretsOrThrow(): LoadedSecrets {
  const sourceFiles = resolveSourceFiles();
  const merged = new Map<string, string>();
  const readOk: string[] = [];
  const errors: string[] = [];
  for (const file of sourceFiles) {
    try {
      const contents = readFileSync(file, "utf8");
      for (const [name, value] of parseEnvAdsValues(contents)) merged.set(name, value);
      readOk.push(file);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }
  if (readOk.length === 0) {
    throw new RunLogRedactionUnavailableError(
      `could not read any credential source file (${sourceFiles.join(", ")}) to redact against: ${errors.join("; ")}`,
    );
  }
  const entriesByLengthDesc = [...merged.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value.length - a.value.length);
  return { entriesByLengthDesc, loadedAt: Date.now() };
}

// LOUD failure mode: a load failure is never swallowed into "nothing to
// redact". The first-ever load must succeed or every caller throws (the
// write never lands unredacted). After that, a refresh failure keeps serving
// the last known-good set -- so protection never silently drops to zero --
// but logs at error level on every throttled attempt, because a persistently
// broken refresh (the source file is gone, perms changed) must stay visible
// forever, not scroll off after one log line. This is the inverse of the
// watchdog defect (PPC-7676) that reported GREEN from its own crash path.
function getSecretsForRedaction(): LoadedSecrets {
  const now = Date.now();
  if (lastGood && now - lastAttemptAt < RELOAD_INTERVAL_MS) return lastGood;
  lastAttemptAt = now;
  try {
    lastGood = loadSecretsOrThrow();
    return lastGood;
  } catch (err) {
    if (now - lastFailureLoggedAt > FAILURE_LOG_THROTTLE_MS) {
      lastFailureLoggedAt = now;
      console.error(
        `[run-log-secret-redaction] SECRET REDACTION LOAD FAILED -- ${
          lastGood
            ? "continuing to redact against the last known-good credential set"
            : "refusing to write run-log output unredacted"
        }: ${(err as Error).message}`,
      );
    }
    if (lastGood) return lastGood;
    throw err;
  }
}

export function redactKnownSecretValues(text: string): string {
  if (!text) return text;
  const { entriesByLengthDesc } = getSecretsForRedaction();
  if (entriesByLengthDesc.length === 0) return text;
  let result = text;
  for (const { name, value } of entriesByLengthDesc) {
    if (!result.includes(value)) continue;
    result = result.split(value).join(`***REDACTED:${name}***`);
  }
  return result;
}

export function resetRunLogSecretRedactionCacheForTests(): void {
  lastGood = null;
  lastAttemptAt = 0;
  lastFailureLoggedAt = 0;
}
