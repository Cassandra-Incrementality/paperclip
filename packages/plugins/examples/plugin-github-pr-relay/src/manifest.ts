import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-github-pr-relay",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub PR Comment Relay",
  description:
    "Relays GitHub PR comments that mention Paperclip issue identifiers (e.g. CAS-123) as comments on the corresponding Paperclip issues.",
  author: "Cassandra",
  categories: ["connector", "automation"],
  capabilities: [
    "issues.read",
    "issue.comments.create",
    "webhooks.receive",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  webhooks: [
    {
      endpointKey: "github",
      displayName: "GitHub Webhook",
      description:
        "Receives GitHub webhook events for issue_comment and pull_request_review_comment.",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      webhookSecret: {
        type: "string",
        format: "secret-ref",
        description: "GitHub webhook secret for signature verification.",
      },
    },
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "relay-health",
        displayName: "PR Comment Relay",
        exportName: "DashboardWidget",
      },
    ],
  },
};

export default manifest;
