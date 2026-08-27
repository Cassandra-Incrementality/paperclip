export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
}

const DEFAULT_HTTP_PORT = 3001;
const DEFAULT_HTTP_HOST = "127.0.0.1";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL");
  }
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY);
  if (!apiKey) {
    throw new Error("Missing PAPERCLIP_API_KEY");
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey,
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
  };
}

/**
 * Build the config for a single HTTP request from the credential that request
 * presented. Nothing here is retained between requests - that is the point.
 */
export function buildRequestConfig(input: {
  apiUrl: string;
  apiKey: string;
  companyId?: string | null;
  agentId?: string | null;
  runId?: string | null;
}): PaperclipMcpConfig {
  return {
    apiUrl: normalizeApiUrl(input.apiUrl),
    apiKey: input.apiKey.trim(),
    companyId: nonEmpty(input.companyId ?? undefined),
    agentId: nonEmpty(input.agentId ?? undefined),
    runId: nonEmpty(input.runId ?? undefined),
  };
}

export interface PaperclipMcpHttpConfig {
  apiUrl: string;
  /** Default company for company-scoped tools when a caller sends no override. */
  companyId: string | null;
  host: string;
  port: number;
}

/**
 * HTTP mode deliberately has no credential of its own. Every request carries
 * its own bearer token, so an ambient `PAPERCLIP_API_KEY` in the environment
 * can only be a mistake - refuse to start rather than let one creep back in.
 */
export function readHttpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpHttpConfig {
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL");
  }
  if (nonEmpty(env.PAPERCLIP_API_KEY)) {
    throw new Error(
      "PAPERCLIP_API_KEY must not be set in HTTP mode. HTTP callers authenticate per request with their own Authorization: Bearer header.",
    );
  }

  const rawPort = nonEmpty(env.PAPERCLIP_MCP_HTTP_PORT) ?? nonEmpty(env.PORT);
  const port = rawPort === null ? DEFAULT_HTTP_PORT : Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    host: nonEmpty(env.PAPERCLIP_MCP_HTTP_HOST) ?? DEFAULT_HTTP_HOST,
    port,
  };
}
