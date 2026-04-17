import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "@modelcontextprotocol/sdk/deps.js";

const API = process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100";
const EMAIL = process.env.PAPERCLIP_EMAIL || "gabriele@cassandra.app";
const PASSWORD = process.env.PAPERCLIP_PASSWORD;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "c19d22c4-0650-4862-889b-9a88be3b5668";

let sessionCookie = null;

async function auth() {
  if (sessionCookie) return sessionCookie;
  const res = await fetch(`${API}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/session_token=([^;]+)/);
  if (match) {
    sessionCookie = match[1];
    return sessionCookie;
  }
  const data = await res.json();
  if (data.token) {
    sessionCookie = data.token;
    return sessionCookie;
  }
  throw new Error("Auth failed");
}

async function api(method, path, body) {
  const token = await auth();
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Cookie": `__Secure-better-auth.session_token=${token}`,
      "Origin": API,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const server = new McpServer({
  name: "paperclip",
  version: "1.0.0",
});

// List issues
server.tool(
  "list_issues",
  "List issues in the Cassandra Paperclip company. Filter by status or assignee.",
  {
    status: z.string().optional().describe("Filter: backlog,todo,in_progress,in_review,blocked,done,cancelled"),
    assignee: z.string().optional().describe("Filter by agent name (e.g. 'CS Ops', 'Data Scientist')"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ status, assignee, limit }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (limit) params.set("limit", String(limit));
    const data = await api("GET", `/companies/${COMPANY_ID}/issues?${params}`);
    let issues = Array.isArray(data) ? data : data.issues || data.items || [];
    if (assignee) {
      const agents = await api("GET", `/companies/${COMPANY_ID}/agents`);
      const agent = agents.find(a => a.name.toLowerCase().includes(assignee.toLowerCase()));
      if (agent) {
        issues = issues.filter(i => i.assigneeAgentId === agent.id);
      }
    }
    const summary = issues.map(i =>
      `${i.identifier || "?"} | ${i.status} | ${i.title}${i.assigneeAgentId ? ` [assigned]` : ""}`
    ).join("\n");
    return { content: [{ type: "text", text: summary || "No issues found." }] };
  }
);

// Create issue
server.tool(
  "create_issue",
  "Create a new issue in Paperclip and optionally assign it to an agent (which auto-triggers execution).",
  {
    title: z.string().describe("Issue title"),
    description: z.string().optional().describe("Detailed description of the task"),
    assignee: z.string().optional().describe("Agent name to assign (e.g. 'CS Ops', 'Data Scientist', 'Ads Ops', 'SEO Ops', 'Giul.ia', 'DevOps', 'Creative Ops')"),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional().describe("Priority level"),
    status: z.enum(["backlog", "todo"]).optional().describe("Initial status (default: todo)"),
  },
  async ({ title, description, assignee, priority, status }) => {
    const body = {
      title,
      description: description || null,
      priority: priority || "medium",
      status: status || "todo",
    };
    if (assignee) {
      const agents = await api("GET", `/companies/${COMPANY_ID}/agents`);
      const agent = agents.find(a => a.name.toLowerCase().includes(assignee.toLowerCase()));
      if (agent) {
        body.assigneeAgentId = agent.id;
      } else {
        return { content: [{ type: "text", text: `Agent "${assignee}" not found. Available: ${agents.map(a => a.name).join(", ")}` }] };
      }
    }
    const issue = await api("POST", `/companies/${COMPANY_ID}/issues`, body);
    const assigned = body.assigneeAgentId ? ` → assigned to ${assignee} (heartbeat auto-triggered)` : "";
    return { content: [{ type: "text", text: `Created ${issue.identifier}: ${issue.title}${assigned}` }] };
  }
);

// Update issue
server.tool(
  "update_issue",
  "Update an existing Paperclip issue (status, assignee, priority, description).",
  {
    identifier: z.string().describe("Issue identifier (e.g. CAS-1) or issue ID"),
    status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]).optional(),
    assignee: z.string().optional().describe("Agent name to reassign to"),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    description: z.string().optional(),
  },
  async ({ identifier, status, assignee, priority, description }) => {
    // Resolve identifier to ID
    const issues = await api("GET", `/companies/${COMPANY_ID}/issues`);
    const allIssues = Array.isArray(issues) ? issues : issues.issues || issues.items || [];
    const issue = allIssues.find(i =>
      i.identifier === identifier || i.id === identifier || i.identifier?.toLowerCase() === identifier.toLowerCase()
    );
    if (!issue) {
      return { content: [{ type: "text", text: `Issue "${identifier}" not found.` }] };
    }
    const body = {};
    if (status) body.status = status;
    if (priority) body.priority = priority;
    if (description) body.description = description;
    if (assignee) {
      const agents = await api("GET", `/companies/${COMPANY_ID}/agents`);
      const agent = agents.find(a => a.name.toLowerCase().includes(assignee.toLowerCase()));
      if (agent) body.assigneeAgentId = agent.id;
    }
    const updated = await api("PATCH", `/companies/${COMPANY_ID}/issues/${issue.id}`, body);
    return { content: [{ type: "text", text: `Updated ${updated.identifier || identifier}: ${JSON.stringify(body)}` }] };
  }
);

// Add comment
server.tool(
  "add_comment",
  "Add a comment to a Paperclip issue.",
  {
    identifier: z.string().describe("Issue identifier (e.g. CAS-1)"),
    comment: z.string().describe("Comment text (supports markdown)"),
  },
  async ({ identifier, comment }) => {
    const issues = await api("GET", `/companies/${COMPANY_ID}/issues`);
    const allIssues = Array.isArray(issues) ? issues : issues.issues || issues.items || [];
    const issue = allIssues.find(i =>
      i.identifier === identifier || i.id === identifier || i.identifier?.toLowerCase() === identifier.toLowerCase()
    );
    if (!issue) {
      return { content: [{ type: "text", text: `Issue "${identifier}" not found.` }] };
    }
    await api("POST", `/companies/${COMPANY_ID}/issues/${issue.id}/comments`, { body: comment });
    return { content: [{ type: "text", text: `Comment added to ${identifier}.` }] };
  }
);

// List agents
server.tool(
  "list_agents",
  "List all agents in the Cassandra Paperclip company with their status and role.",
  {},
  async () => {
    const agents = await api("GET", `/companies/${COMPANY_ID}/agents`);
    const summary = agents.map(a =>
      `${a.name} | ${a.role} | ${a.status} | ${a.title || ""}`
    ).join("\n");
    return { content: [{ type: "text", text: summary }] };
  }
);

// Wake agent
server.tool(
  "wake_agent",
  "Manually trigger a heartbeat on an agent to wake it up and process its inbox.",
  {
    agent: z.string().describe("Agent name (e.g. 'CS Ops')"),
  },
  async ({ agent: agentName }) => {
    const agents = await api("GET", `/companies/${COMPANY_ID}/agents`);
    const agent = agents.find(a => a.name.toLowerCase().includes(agentName.toLowerCase()));
    if (!agent) {
      return { content: [{ type: "text", text: `Agent "${agentName}" not found.` }] };
    }
    const run = await api("POST", `/agents/${agent.id}/wakeup`, { source: "on_demand", trigger: "manual" });
    return { content: [{ type: "text", text: run.status === "skipped" ? `Agent skipped (already running or disabled).` : `Heartbeat queued: ${run.id} (status: ${run.status})` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
