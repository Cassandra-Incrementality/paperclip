#!/usr/bin/env node
/**
 * Device-code login for the Paperclip MCP stdio server.
 *
 * Opens a CLI auth challenge, waits for a signed-in board user to approve it in
 * the browser, and writes the resulting board API key straight into an MCP
 * client config. The key value is never printed, echoed, or logged - it goes
 * from the API response into the config file and nowhere else.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { normalizeApiUrl } from "./config.js";

const POLL_INTERVAL_MS = 1000;
const CLIENT_NAME = "Claude Code (paperclip MCP)";
const LEGACY_ENV_KEYS = ["PAPERCLIP_EMAIL", "PAPERCLIP_PASSWORD"];

interface CliOptions {
  apiUrl: string;
  configPath: string;
  serverName: string;
  companyId: string | null;
}

interface ChallengeCreated {
  id: string;
  token: string;
  boardApiToken: string;
  approvalPath: string;
  approvalUrl: string | null;
  expiresAt: string;
  suggestedPollIntervalMs?: number;
}

function usage(): string {
  return [
    "Usage: paperclip-mcp-login [options]",
    "",
    "  --api-url <url>     Paperclip base URL (default: $PAPERCLIP_API_URL)",
    "  --config <path>     MCP client config to update (default: ~/.claude/mcp.json)",
    "  --server <name>     Server entry name inside the config (default: paperclip)",
    "  --company <uuid>    Default company id (default: $PAPERCLIP_COMPANY_ID)",
    "",
    "The minted key is written to the config file only. It is never printed.",
  ].join("\n");
}

function expandHome(value: string): string {
  return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
}

function parseArgs(argv: string[]): CliOptions {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.error(usage());
      process.exit(0);
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    flags.set(arg.slice(2), value);
    index += 1;
  }

  const apiUrl = flags.get("api-url") ?? process.env.PAPERCLIP_API_URL;
  if (!apiUrl) throw new Error("Missing --api-url (or PAPERCLIP_API_URL)");

  const configPath = expandHome(flags.get("config") ?? "~/.claude/mcp.json");

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    configPath: isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath),
    serverName: flags.get("server") ?? "paperclip",
    companyId: flags.get("company") ?? process.env.PAPERCLIP_COMPANY_ID ?? null,
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitForApproval(options: CliOptions, challenge: ChallengeCreated): Promise<void> {
  const pollUrl = `${options.apiUrl}/cli-auth/challenges/${challenge.id}?token=${encodeURIComponent(challenge.token)}`;
  const interval = challenge.suggestedPollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.parse(challenge.expiresAt);

  for (;;) {
    const response = await fetch(pollUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Challenge poll failed with ${response.status}`);
    }
    const state = (await response.json()) as { status: string };
    if (state.status === "approved") return;
    if (state.status !== "pending") {
      throw new Error(`Challenge ${state.status}. Re-run to start a new one.`);
    }
    if (Date.now() > deadline) {
      throw new Error("Challenge expired before approval. Re-run to start a new one.");
    }
    await sleep(interval);
  }
}

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Rewrites a single server entry in place, keeping however the entry already
 * launches the server. Any legacy password-auth env is dropped rather than
 * carried forward.
 */
function writeConfigEntry(options: CliOptions, boardApiToken: string): { removedKeys: string[] } {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(options.configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const servers = (config.mcpServers ?? {}) as Record<string, McpServerEntry>;
  const existing = servers[options.serverName] ?? {};
  const env = { ...(existing.env ?? {}) };

  const removedKeys = LEGACY_ENV_KEYS.filter((key) => key in env);
  for (const key of removedKeys) delete env[key];

  env.PAPERCLIP_API_URL = options.apiUrl.replace(/\/api$/, "");
  env.PAPERCLIP_API_KEY = boardApiToken;
  if (options.companyId) env.PAPERCLIP_COMPANY_ID = options.companyId;

  servers[options.serverName] = {
    command: existing.command ?? "npx",
    args: existing.args ?? ["-y", "@paperclipai/mcp-server"],
    env,
  };
  config.mcpServers = servers;

  writeFileSync(options.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(options.configPath, 0o600);
  return { removedKeys };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const challenge = await postJson<ChallengeCreated>(`${options.apiUrl}/cli-auth/challenges`, {
    command: "paperclip-mcp-login",
    clientName: CLIENT_NAME,
    requestedAccess: "board",
    requestedCompanyId: options.companyId,
  });

  const approvalUrl =
    challenge.approvalUrl ?? `${options.apiUrl.replace(/\/api$/, "")}${challenge.approvalPath}`;

  console.error("Approve this Paperclip MCP login while signed in to the board:");
  console.error(`  ${approvalUrl}`);
  console.error(`  (expires ${challenge.expiresAt})`);
  console.error("Waiting for approval...");

  await waitForApproval(options, challenge);
  const { removedKeys } = writeConfigEntry(options, challenge.boardApiToken);

  console.error(`Approved. Board key written to ${options.configPath} (value not shown), mode 0600.`);
  if (removedKeys.length > 0) {
    console.error(`Removed legacy credentials from that entry: ${removedKeys.join(", ")}.`);
  }
}

void main().catch((error) => {
  console.error("paperclip-mcp-login failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
