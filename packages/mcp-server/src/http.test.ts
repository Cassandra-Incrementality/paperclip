import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHttpConfigFromEnv, type PaperclipMcpHttpConfig } from "./config.js";
import { createPaperclipMcpHttpServer, type PaperclipMcpHttpServer } from "./http.js";

const API_BASE = "http://paperclip.test/api";
const DEFAULT_COMPANY = "11111111-1111-1111-1111-111111111111";

const servers: PaperclipMcpHttpServer[] = [];

function makeConfig(overrides: Partial<PaperclipMcpHttpConfig> = {}): PaperclipMcpHttpConfig {
  return {
    apiUrl: API_BASE,
    companyId: DEFAULT_COMPANY,
    host: "127.0.0.1",
    port: 0,
    ...overrides,
  };
}

interface ApiCall {
  url: string;
  token: string;
}

interface ApiStub {
  calls: ApiCall[];
  distinctTokens: Set<string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Intercepts calls to the fake Paperclip API and answers with an identity
 * derived from the presented token, so a caller's own credential is visible in
 * its tool output. Everything else (the MCP client talking to the server under
 * test) passes through to real fetch.
 *
 * `gateUntilDistinctTokens` holds every API call open until that many distinct
 * tokens have arrived, forcing genuine overlap rather than accidental
 * serialisation.
 */
function stubPaperclipApi(options: { gateUntilDistinctTokens?: number } = {}): ApiStub {
  const realFetch = globalThis.fetch.bind(globalThis);
  const calls: ApiCall[] = [];
  const distinctTokens = new Set<string>();
  const gateTarget = options.gateUntilDistinctTokens ?? 0;

  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  const stub = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String((input as Request).url);
    if (!url.startsWith(API_BASE)) {
      return realFetch(input as RequestInfo, init);
    }

    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = String(headers.Authorization ?? "").replace(/^Bearer /, "");
    calls.push({ url, token });
    distinctTokens.add(token);

    if (gateTarget > 0) {
      if (distinctTokens.size >= gateTarget) openGate();
      // Safety valve: a missing second caller should fail an assertion, not hang.
      await Promise.race([gate, sleep(1500)]);
    }

    return new Response(JSON.stringify({ actor: `identity-for:${token}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  vi.stubGlobal("fetch", stub);
  return { calls, distinctTokens };
}

async function startServer(config: PaperclipMcpHttpConfig = makeConfig()) {
  const instance = createPaperclipMcpHttpServer({ config });
  const port = await instance.listen(0, "127.0.0.1");
  servers.push(instance);
  return { base: `http://127.0.0.1:${port}` };
}

async function mcpClient(base: string, headers?: Record<string, string>) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: headers ? { headers } : undefined,
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((entry) => entry.text ?? "").join("\n");
}

afterEach(async () => {
  while (servers.length) {
    const instance = servers.pop();
    if (instance) await instance.close();
  }
  vi.unstubAllGlobals();
});

describe("Paperclip MCP HTTP transport", () => {
  it("rejects an anonymous request with 401 before any tool dispatch", async () => {
    const api = stubPaperclipApi();
    const { base } = await startServer();

    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="paperclip"');
    expect(await response.json()).toMatchObject({ error: "unauthorized" });
    expect(api.calls).toHaveLength(0);
  });

  it("rejects a malformed Authorization header with 401", async () => {
    stubPaperclipApi();
    const { base } = await startServer();

    for (const authorization of ["Basic abc123", "Bearer", "Bearer    ", "token-without-scheme"]) {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status, `authorization: ${authorization}`).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_request"');
    }
  });

  it("404s paths that are not the MCP endpoint", async () => {
    stubPaperclipApi();
    const { base } = await startServer();

    const response = await fetch(`${base}/healthz`, { headers: { authorization: "Bearer token-alpha" } });
    expect(response.status).toBe(404);
  });

  it("forwards the caller's own token to the Paperclip API", async () => {
    const api = stubPaperclipApi();
    const { base } = await startServer();
    const client = await mcpClient(base, { authorization: "Bearer token-alpha" });

    try {
      const result = await client.callTool({ name: "paperclipMe", arguments: {} });
      expect(textOf(result)).toContain("identity-for:token-alpha");
      expect(api.calls).toEqual([{ url: `${API_BASE}/agents/me`, token: "token-alpha" }]);
    } finally {
      await client.close();
    }
  });

  // Regression test for the shared-session defect (PPC-4052): the retired fork
  // kept one client under the literal key "default", so whoever authenticated
  // first lent their session to every later caller.
  it("keeps concurrent callers with different bearer tokens on their own identity", async () => {
    const api = stubPaperclipApi({ gateUntilDistinctTokens: 2 });
    const { base } = await startServer();

    const alpha = await mcpClient(base, { authorization: "Bearer token-alpha" });
    const beta = await mcpClient(base, { authorization: "Bearer token-beta" });

    try {
      const [alphaResult, betaResult] = await Promise.all([
        alpha.callTool({ name: "paperclipMe", arguments: {} }),
        beta.callTool({ name: "paperclipMe", arguments: {} }),
      ]);

      expect(textOf(alphaResult)).toContain("identity-for:token-alpha");
      expect(textOf(betaResult)).toContain("identity-for:token-beta");
      expect(textOf(alphaResult)).not.toContain("token-beta");
      expect(textOf(betaResult)).not.toContain("token-alpha");
      expect([...api.distinctTokens].sort()).toEqual(["token-alpha", "token-beta"]);
    } finally {
      await alpha.close();
      await beta.close();
    }
  }, 15_000);

  it("does not leak one caller's company default onto another's request", async () => {
    const api = stubPaperclipApi();
    const { base } = await startServer();

    const scoped = await mcpClient(base, {
      authorization: "Bearer token-alpha",
      "x-paperclip-company-id": "22222222-2222-2222-2222-222222222222",
    });
    const unscoped = await mcpClient(base, { authorization: "Bearer token-beta" });

    try {
      await scoped.callTool({ name: "paperclipListIssues", arguments: {} });
      await unscoped.callTool({ name: "paperclipListIssues", arguments: {} });

      expect(api.calls.map((call) => call.url)).toEqual([
        `${API_BASE}/companies/22222222-2222-2222-2222-222222222222/issues`,
        `${API_BASE}/companies/${DEFAULT_COMPANY}/issues`,
      ]);
    } finally {
      await scoped.close();
      await unscoped.close();
    }
  });
});

describe("readHttpConfigFromEnv", () => {
  it("refuses to start with an ambient PAPERCLIP_API_KEY", () => {
    expect(() =>
      readHttpConfigFromEnv({
        PAPERCLIP_API_URL: "http://paperclip.test",
        PAPERCLIP_API_KEY: "pcp_board_deadbeef",
      } as NodeJS.ProcessEnv),
    ).toThrow(/must not be set in HTTP mode/);
  });

  it("normalizes the API url and reads the port from the environment", () => {
    const config = readHttpConfigFromEnv({
      PAPERCLIP_API_URL: "http://paperclip.test/",
      PAPERCLIP_MCP_HTTP_HOST: "0.0.0.0",
      PORT: "3001",
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      apiUrl: "http://paperclip.test/api",
      companyId: null,
      host: "0.0.0.0",
      port: 3001,
    });
  });
});
