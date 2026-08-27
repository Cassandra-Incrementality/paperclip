import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildRequestConfig, type PaperclipMcpHttpConfig } from "./config.js";
import { createPaperclipMcpServer } from "./index.js";

export interface PaperclipMcpHttpOptions {
  config: PaperclipMcpHttpConfig;
}

export interface PaperclipMcpHttpServer {
  server: Server;
  /** Resolves to the bound port once listening. */
  listen: (port: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
}

const MCP_PATHS = new Set(["/mcp", "/"]);
const MAX_BODY_BYTES = 1_000_000;
const REALM = 'Bearer realm="paperclip"';

type Unauthorized = { reason: "missing" | "malformed" };

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendUnauthorized(res: ServerResponse, { reason }: Unauthorized): void {
  const description =
    reason === "missing"
      ? "Send Authorization: Bearer <paperclip token>."
      : "Malformed Authorization header. Expected: Bearer <paperclip token>.";
  sendJson(
    res,
    401,
    { error: "unauthorized", error_description: description },
    {
      // RFC 6750 3.1: only a rejected credential carries an error code; an
      // absent one just advertises the scheme.
      "www-authenticate":
        reason === "missing" ? REALM : `${REALM}, error="invalid_request", error_description="${description}"`,
    },
  );
}

/**
 * The caller's own credential, or the reason we will not serve them. Presence
 * is all we check: `actorMiddleware` on the API resolves board keys, agent keys
 * and run JWTs, so validating the token here would only duplicate it - badly.
 */
function readBearerToken(req: IncomingMessage): { token: string } | Unauthorized {
  const header = req.headers.authorization;
  if (typeof header !== "string" || header.trim().length === 0) return { reason: "missing" };
  if (!header.toLowerCase().startsWith("bearer ")) return { reason: "malformed" };
  const token = header.slice("bearer ".length).trim();
  if (!token) return { reason: "malformed" };
  return { token };
}

function readHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  httpConfig: PaperclipMcpHttpConfig,
  token: string,
): Promise<void> {
  let parsedBody: unknown;
  try {
    parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined;
  } catch (error) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: error instanceof Error ? error.message : "Parse error" },
      id: null,
    });
    return;
  }

  // Everything below is built from this request's credential and discarded with
  // it. No module state, no map, no "default" client: that shared-session bug is
  // exactly what this transport replaces.
  const config = buildRequestConfig({
    apiUrl: httpConfig.apiUrl,
    apiKey: token,
    companyId: readHeader(req, "x-paperclip-company-id") ?? httpConfig.companyId,
    agentId: readHeader(req, "x-paperclip-agent-id"),
    runId: readHeader(req, "x-paperclip-run-id"),
  });

  const { server } = createPaperclipMcpServer(config);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

export function createPaperclipMcpHttpServer(options: PaperclipMcpHttpOptions): PaperclipMcpHttpServer {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (!MCP_PATHS.has(url.pathname)) {
          sendJson(res, 404, { error: "Not found." });
          return;
        }

        const auth = readBearerToken(req);
        if ("reason" in auth) {
          sendUnauthorized(res, auth);
          return;
        }

        await handleMcp(req, res, options.config, auth.token);
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal error." });
        } else {
          res.end();
        }
      }
    })();
  });

  return {
    server,
    listen: (port, host = "127.0.0.1") =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
