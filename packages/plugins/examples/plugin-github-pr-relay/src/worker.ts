import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginWebhookInput, PluginContext } from "@paperclipai/plugin-sdk";

const CAS_PATTERN = /\b([A-Z]{2,10}-\d+)\b/g;

interface GitHubUser {
  login: string;
  html_url: string;
}

interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser;
  html_url: string;
  created_at: string;
}

interface GitHubPR {
  number: number;
  title: string;
  html_url: string;
}

interface GitHubCommentEvent {
  action: string;
  comment: GitHubComment;
  pull_request?: GitHubPR;
  issue?: { pull_request?: unknown; number: number; title: string; html_url: string };
}

function extractIdentifiers(text: string): string[] {
  const matches = text.match(CAS_PATTERN);
  if (!matches) return [];
  return [...new Set(matches)];
}

function formatRelayComment(
  comment: GitHubComment,
  pr: { number: number; title: string; html_url: string },
): string {
  return [
    `**GitHub PR comment** from [@${comment.user.login}](${comment.user.html_url})`,
    `on [#${pr.number} ${pr.title}](${pr.html_url}):`,
    "",
    "> " + comment.body.split("\n").join("\n> "),
    "",
    `[View on GitHub](${comment.html_url})`,
  ].join("\n");
}

let pluginCtx: PluginContext;

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;

    ctx.data.register("health", async () => {
      const relayedCount = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "relayed_count",
      });
      const lastRelayedAt = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "last_relayed_at",
      });
      return {
        status: "ok",
        relayedCount: relayedCount ?? 0,
        lastRelayedAt: lastRelayedAt ?? null,
        checkedAt: new Date().toISOString(),
      };
    });
  },

  async onHealth() {
    return { status: "ok", message: "GitHub PR Comment Relay is running" };
  },

  async onWebhook(input: PluginWebhookInput) {
    const ctx = pluginCtx;

    if (input.endpointKey !== "github") {
      throw new Error(`Unknown webhook endpoint: ${input.endpointKey}`);
    }

    const event = input.headers["x-github-event"];
    const githubEvent = Array.isArray(event) ? event[0] : event;

    if (
      githubEvent !== "issue_comment" &&
      githubEvent !== "pull_request_review_comment"
    ) {
      ctx.logger.debug("Ignoring non-comment GitHub event", {
        event: githubEvent,
      });
      return;
    }

    const payload = input.parsedBody as GitHubCommentEvent;

    if (payload.action !== "created") {
      ctx.logger.debug("Ignoring non-created action", {
        action: payload.action,
      });
      return;
    }

    if (!payload.comment?.body) {
      ctx.logger.warn("Webhook payload missing comment body");
      return;
    }

    const pr = payload.pull_request ??
      (payload.issue?.pull_request ? payload.issue : undefined);
    if (!pr) {
      ctx.logger.debug("Comment is not on a pull request, skipping");
      return;
    }

    const identifiers = extractIdentifiers(payload.comment.body);
    if (identifiers.length === 0) {
      ctx.logger.debug("No issue identifiers found in comment");
      return;
    }

    const dedupKey = `gh-comment-${payload.comment.id}`;
    const alreadyRelayed = await ctx.state.get({
      scopeKind: "instance",
      stateKey: dedupKey,
    });
    if (alreadyRelayed) {
      ctx.logger.debug("Comment already relayed, skipping", {
        commentId: payload.comment.id,
      });
      return;
    }

    const body = formatRelayComment(payload.comment, {
      number: pr.number,
      title: pr.title,
      html_url: pr.html_url,
    });

    let relayedCount = 0;
    for (const identifier of identifiers) {
      try {
        const issue = await ctx.issues.getByIdentifier(identifier);
        if (!issue) {
          ctx.logger.debug("Issue not found for identifier", { identifier });
          continue;
        }

        await ctx.issues.createComment(issue.id, body, issue.companyId);

        await ctx.activity.log({
          companyId: issue.companyId,
          entityType: "issue",
          entityId: issue.id,
          message: `Relayed GitHub PR comment from @${payload.comment.user.login} on PR #${pr.number}`,
          metadata: {
            githubCommentId: payload.comment.id,
            githubCommentUrl: payload.comment.html_url,
            githubUser: payload.comment.user.login,
          },
        });

        relayedCount++;
        ctx.logger.info("Relayed comment to issue", {
          identifier,
          issueId: issue.id,
          githubCommentId: payload.comment.id,
        });
      } catch (err) {
        ctx.logger.error("Failed to relay comment to issue", {
          identifier,
          error: String(err),
        });
      }
    }

    if (relayedCount > 0) {
      await ctx.state.set(
        { scopeKind: "instance", stateKey: dedupKey },
        true,
      );

      const currentCount =
        ((await ctx.state.get({
          scopeKind: "instance",
          stateKey: "relayed_count",
        })) as number) ?? 0;
      await ctx.state.set(
        { scopeKind: "instance", stateKey: "relayed_count" },
        currentCount + relayedCount,
      );
      await ctx.state.set(
        { scopeKind: "instance", stateKey: "last_relayed_at" },
        new Date().toISOString(),
      );
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
