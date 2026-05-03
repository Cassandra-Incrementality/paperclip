import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * Knowledge file sync — periodically re-ingests local markdown files
 * into the Paperclip knowledge base, updating changed files and adding new ones.
 */

const MIN_FILE_SIZE = 500;
const MAX_FILE_SIZE = 200_000;
const SKIP_DIRS = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".git", ".nox",
  ".pytest_cache", ".ruff_cache", "dist", "build", ".tox", ".next",
]);
const SKIP_FILES = new Set(["CHANGELOG.md", "LICENSE.md", "package-lock.json"]);
const HOME = process.env.HOME ?? "/Users/jarvis";

interface SourceConfig {
  paths: string[];
  tagPrefix: string;
  kind: string;
  confidence: number;
  tier: string;
  maxDepth: number;
}

function getSources(): SourceConfig[] {
  const instanceRoot = resolvePaperclipInstanceRoot();
  return [
    {
      paths: [`${HOME}/.openclaw/workspace/tmp/signal_pipeline`],
      tagPrefix: "domain/methodology",
      kind: "reference",
      confidence: 0.95,
      tier: "procedural",
      maxDepth: 1,
    },
    {
      paths: [`${HOME}/.openclaw/workspace/autoresearch`],
      tagPrefix: "domain/research",
      kind: "reference",
      confidence: 0.85,
      tier: "semantic",
      maxDepth: 3,
    },
    {
      paths: [`${HOME}/.openclaw/workspace/mmm_toolkit`],
      tagPrefix: "domain/mmm-toolkit",
      kind: "reference",
      confidence: 0.9,
      tier: "procedural",
      maxDepth: 2,
    },
    {
      paths: [`${instanceRoot}/workspaces`],
      tagPrefix: "source/agent-workspace",
      kind: "reference",
      confidence: 0.8,
      tier: "semantic",
      maxDepth: 4,
    },
    {
      paths: [`${HOME}/.claude/commands`, `${HOME}/.openclaw/workspace/.claude/commands`],
      tagPrefix: "domain/skills",
      kind: "procedural",
      confidence: 0.9,
      tier: "procedural",
      maxDepth: 2,
    },
    {
      paths: [`${HOME}/.claude/projects/-Users-jarvis/memory`],
      tagPrefix: "domain/memory",
      kind: "reference",
      confidence: 0.85,
      tier: "semantic",
      maxDepth: 1,
    },
    {
      paths: [
        `${HOME}/.openclaw/workspace/customer-success`,
        `${HOME}/.openclaw/workspace/ads`,
        `${HOME}/.openclaw/workspace/content`,
        `${HOME}/.openclaw/workspace/cassandra-monitor`,
        `${HOME}/.openclaw/workspace/cassandra-agent`,
        `${HOME}/.openclaw/workspace/video-pipeline`,
      ],
      tagPrefix: "domain/workspace",
      kind: "reference",
      confidence: 0.75,
      tier: "episodic",
      maxDepth: 3,
    },
    {
      paths: [`${HOME}/paperclip/doc`, `${HOME}/paperclip/docs`],
      tagPrefix: "domain/paperclip",
      kind: "reference",
      confidence: 0.85,
      tier: "semantic",
      maxDepth: 3,
    },
    {
      paths: [`${HOME}/cassandra-saas`],
      tagPrefix: "domain/saas",
      kind: "reference",
      confidence: 0.75,
      tier: "episodic",
      maxDepth: 2,
    },
    {
      paths: [`${HOME}/.openclaw/workspace`],
      tagPrefix: "domain/workspace",
      kind: "reference",
      confidence: 0.8,
      tier: "episodic",
      maxDepth: 1,
    },
  ];
}

async function findMdFiles(basePath: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(path.join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile() && entry.name.endsWith(".md") && !SKIP_FILES.has(entry.name)) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size >= MIN_FILE_SIZE && stat.size <= MAX_FILE_SIZE) {
            results.push(fullPath);
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }
  await walk(basePath, 0);
  return results;
}

function buildSummary(content: string, stem: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const text = trimmed.replace(/^#+\s*/, "").trim();
      if (text.length > 20) return text.slice(0, 200);
    }
    if (trimmed.length > 20 && !trimmed.startsWith("---") && !trimmed.startsWith("```") && !trimmed.startsWith("import")) {
      return trimmed.slice(0, 200);
    }
  }
  return `Documentation: ${stem}`.slice(0, 200);
}

function extractTags(filePath: string, content: string, tagPrefix: string): string[] {
  const tags = new Set([tagPrefix]);
  const text = (filePath + " " + content.slice(0, 2000)).toLowerCase();
  const patterns: Record<string, string[]> = {
    "topic/mmm": ["mmm", "model", "roi", "roas", "adstock"],
    "topic/measurement": ["measurement", "incrementality", "causal", "attribution"],
    "topic/api": ["api", "endpoint", "route", "rest"],
    "topic/agents": ["agent", "heartbeat", "adapter"],
    "topic/clients": ["client", "onboard", "customer"],
    "topic/pipeline": ["pipeline", "signal", "orchestrat"],
    "topic/testing": ["test", "spec", "validation"],
    "topic/config": ["config", "setting", "env"],
  };
  for (const [tag, keywords] of Object.entries(patterns)) {
    if (keywords.some((kw) => text.includes(kw))) {
      tags.add(tag);
    }
  }
  return [...tags].slice(0, 8);
}

export async function syncKnowledgeFiles(db: Db, companyId: string) {
  const sources = getSources();
  const stats = { added: 0, updated: 0, unchanged: 0, errors: 0 };

  // Collect all files with their source config
  const fileMap = new Map<string, SourceConfig>();
  for (const source of sources) {
    for (const basePath of source.paths) {
      const files = await findMdFiles(basePath, source.maxDepth);
      for (const f of files) {
        if (!fileMap.has(f)) {
          fileMap.set(f, source);
        }
      }
    }
  }

  // Get existing file-sourced documents (title contains the file path)
  const existingDocs = await db
    .select({ id: documents.id, title: documents.title, latestBody: documents.latestBody })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, companyId),
        sql`${documents.kind} IN ('reference', 'procedural')`,
        sql`${documents.title} LIKE '%~/%.md)%'`,
      ),
    );

  // Build lookup: relative path -> existing doc
  const existingByPath = new Map<string, { id: string; bodyLength: number }>();
  for (const doc of existingDocs) {
    const match = doc.title?.match(/\((~\/[^)]+)\)/);
    if (match) {
      existingByPath.set(match[1], { id: doc.id, bodyLength: doc.latestBody.length });
    }
  }

  for (const [filePath, source] of fileMap) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const relPath = filePath.replace(HOME, "~");
      const stem = path.basename(filePath, ".md");
      const title = `${stem} (${relPath})`.slice(0, 500);
      const summary = buildSummary(content, stem);
      const tags = extractTags(filePath, content, source.tagPrefix);
      const body = `# ${stem}\n\n**Source:** \`${relPath}\`\n**Indexed:** ${new Date().toISOString().split("T")[0]}\n\n---\n\n${content}`;

      const existing = existingByPath.get(relPath);
      if (existing) {
        if (Math.abs(existing.bodyLength - body.length) < 10) {
          stats.unchanged++;
          continue;
        }
        await db
          .update(documents)
          .set({ latestBody: body, summary, tags, updatedAt: new Date() })
          .where(eq(documents.id, existing.id));
        stats.updated++;
      } else {
        await db.insert(documents).values({
          companyId,
          title,
          format: "markdown",
          latestBody: body,
          latestRevisionNumber: 1,
          kind: source.kind,
          summary,
          tags,
          confidence: source.confidence,
          sourceCount: 1,
          decayTier: source.tier,
          lastReinforcedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        stats.added++;
      }
    } catch {
      stats.errors++;
    }
  }
  return stats;
}
