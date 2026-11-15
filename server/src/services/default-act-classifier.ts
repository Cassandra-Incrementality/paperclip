// TypeScript port of cassandra-brain/scripts/board_card_classifier.py's
// classify_text() (PPC-7478 ruling, write-side PPC-7562). The regexes below
// are NEVER hand-typed here — they are loaded from the vendored export in
// ../generated/default-act-rules.json. Regenerate that file with
// scripts/regen-default-act-rules.sh when the ruling changes; never hand-edit
// it, and never add a rule here that the classifier doesn't also export.
//
// Dialect gap (documented in the export's own semantics.dialect_warning):
// Python's \b is Unicode-aware, JS's is ASCII-only. The vendored
// `conformance[]` suite is the parity check — see
// default-act-classifier.test.ts — not an assumption.
import { readFileSync } from "node:fs";

interface DefaultActRule {
  rule: string;
  patterns: string[];
}

interface DefaultActRulesExport {
  default_act_days: number;
  recommendation: string;
  reserved: DefaultActRule[];
  ambiguous: DefaultActRule[];
  conformance: { text: string; bucket: string; rule: string | null }[];
}

const rulesUrl = new URL("../generated/default-act-rules.json", import.meta.url);
export const DEFAULT_ACT_RULES: DefaultActRulesExport = JSON.parse(readFileSync(rulesUrl, "utf8"));
export const DEFAULT_ACT_DAYS = DEFAULT_ACT_RULES.default_act_days;

// "case-insensitive, DOTALL (JS: /su + lowercased input)" per the export's
// own semantics.flags note — text is lowercased before matching, so no /i.
const compile = (pattern: string) => new RegExp(pattern, "su");
const RECOMMENDATION_RE = compile(DEFAULT_ACT_RULES.recommendation);
const RESERVED = DEFAULT_ACT_RULES.reserved.map((r) => ({ rule: r.rule, patterns: r.patterns.map(compile) }));
const AMBIGUOUS = DEFAULT_ACT_RULES.ambiguous.map((r) => ({ rule: r.rule, patterns: r.patterns.map(compile) }));

export type DefaultActBucket = "reserved" | "ambiguous" | "internal_reversible" | "no_recommendation";

export interface DefaultActClassification {
  bucket: DefaultActBucket;
  rule: string | null;
  evidence: string[];
}

interface CardTextOptionLike {
  label?: string | null;
  description?: string | null;
}

interface CardTextPayloadLike {
  title?: string | null;
  prompt?: string | null;
  detailsMarkdown?: string | null;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  submitLabel?: string | null;
  rejectReasonLabel?: string | null;
  options?: CardTextOptionLike[] | null;
  questions?: Array<{ prompt?: string | null; title?: string | null; options?: CardTextOptionLike[] | null }> | null;
  tasks?: Array<{ title?: string | null; description?: string | null }> | null;
}

export interface CardTextSource {
  title?: string | null;
  summary?: string | null;
  payload?: CardTextPayloadLike | null;
}

/** Every author-written surface of a card, flattened — mirrors card_text() field-for-field. */
export function cardText(row: CardTextSource): string {
  const p = row.payload ?? {};
  const parts: Array<string | null | undefined> = [
    row.title, row.summary,
    p.title, p.prompt, p.detailsMarkdown, p.acceptLabel, p.rejectLabel, p.submitLabel, p.rejectReasonLabel,
  ];
  const optionLists: Array<CardTextOptionLike[] | null | undefined> = [p.options];
  for (const q of p.questions ?? []) {
    parts.push(q.prompt, q.title);
    optionLists.push(q.options);
  }
  for (const opts of optionLists) {
    for (const o of opts ?? []) parts.push(o.label, o.description);
  }
  for (const t of p.tasks ?? []) parts.push(t.title, t.description);
  return parts.filter((x): x is string => x != null && x !== "").join("\n");
}

function matchEvidence(patterns: RegExp[], text: string): string[] | null {
  const out: string[] = [];
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (!m) return null;
    out.push(m[0]);
  }
  return out;
}

/** Port of classify_text(): RESERVED first in listed order, then AMBIGUOUS; first firing rule wins. */
export function classifyText(text: string): DefaultActClassification {
  const t = (text || "").toLowerCase();
  const hasRecommendation = RECOMMENDATION_RE.test(t);
  for (const { bucket, rules } of [
    { bucket: "reserved" as const, rules: RESERVED },
    { bucket: "ambiguous" as const, rules: AMBIGUOUS },
  ]) {
    for (const { rule, patterns } of rules) {
      const ev = matchEvidence(patterns, t);
      if (ev !== null) return { bucket, rule, evidence: ev };
    }
  }
  return hasRecommendation
    ? { bucket: "internal_reversible", rule: null, evidence: [] }
    : { bucket: "no_recommendation", rule: null, evidence: [] };
}

export function classifyCard(row: CardTextSource): DefaultActClassification {
  return classifyText(cardText(row));
}

/** Port of _spread_reserved_within_issue(): a card is also held when any other pending card on the same issue is held. */
export function applySiblingHold(
  own: DefaultActClassification,
  siblingBuckets: DefaultActBucket[],
): DefaultActClassification {
  if (own.bucket === "reserved" || own.bucket === "ambiguous") return own;
  const held = siblingBuckets.some((b) => b === "reserved" || b === "ambiguous");
  return held ? { bucket: "reserved", rule: "sibling_reserved", evidence: [] } : own;
}

export function mayDefaultAct(bucket: DefaultActBucket): boolean {
  return bucket === "internal_reversible";
}

export function computeDueAt(bucket: DefaultActBucket, createdAt: Date): string | null {
  if (!mayDefaultAct(bucket)) return null;
  return new Date(createdAt.getTime() + DEFAULT_ACT_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
