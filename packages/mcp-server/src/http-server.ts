#!/usr/bin/env node
import { readHttpConfigFromEnv } from "./config.js";
import { createPaperclipMcpHttpServer } from "./http.js";

async function main(): Promise<void> {
  const config = readHttpConfigFromEnv();
  const { listen } = createPaperclipMcpHttpServer({ config });
  const port = await listen(config.port, config.host);
  const base = `http://${config.host}:${port}`;

  console.error(`Paperclip MCP HTTP server listening on ${base}`);
  console.error(`  MCP endpoint: ${base}/mcp`);
  console.error(`  API:          ${config.apiUrl}`);
  console.error("  Auth:         per request, from the caller's Authorization: Bearer header.");
}

void main().catch((error) => {
  console.error("Failed to start Paperclip MCP HTTP server:", error instanceof Error ? error.message : error);
  process.exit(1);
});
