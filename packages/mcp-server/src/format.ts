import {
  formatSameAgentThreadConflictReconcileInstruction,
  isSameAgentThreadConflictDetails,
} from "@paperclipai/shared";
import { PaperclipApiError } from "./client.js";

type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
};

export function formatTextResponse(value: unknown): McpTextResponse {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorBodyDetails(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  return (body as Record<string, unknown>).details;
}

export function formatErrorResponse(error: unknown): McpTextResponse {
  if (error instanceof PaperclipApiError) {
    // PPC-3302: the same-agent concurrent thread-write guard (PPC-3187) 409s
    // with the conflicting comment attached — surface it as a reconcile
    // instruction instead of a generic failure, or the model loses that
    // comment's content and either drops it or blind-retries into another 409.
    const details = errorBodyDetails(error.body);
    if (error.status === 409 && isSameAgentThreadConflictDetails(details)) {
      return formatTextResponse(formatSameAgentThreadConflictReconcileInstruction(details));
    }
    return formatTextResponse({
      error: error.message,
      status: error.status,
      method: error.method,
      path: error.path,
      body: error.body,
    });
  }
  return formatTextResponse({
    error: error instanceof Error ? error.message : String(error),
  });
}
