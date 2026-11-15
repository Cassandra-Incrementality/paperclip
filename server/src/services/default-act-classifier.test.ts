import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACT_RULES,
  applySiblingHold,
  classifyText,
  computeDueAt,
  mayDefaultAct,
} from "./default-act-classifier.js";

// AC3: the conformance[] suite shipped by `--export-rules` must pass here,
// all 14 cases — the parity proof for the Python/JS \b dialect gap, not an
// assumption.
describe("default-act-classifier conformance (PPC-7562 export)", () => {
  for (const testCase of DEFAULT_ACT_RULES.conformance) {
    it(`classifies: ${testCase.text}`, () => {
      const result = classifyText(testCase.text);
      expect(result.bucket).toBe(testCase.bucket);
      expect(result.rule).toBe(testCase.rule);
    });
  }

  it("ships all 14 documented conformance cases", () => {
    expect(DEFAULT_ACT_RULES.conformance.length).toBe(14);
  });
});

describe("evidence (AC1/AC2: the filer sees the matched words, not just the bucket)", () => {
  it("reports the matched word for a reserved rule", () => {
    const result = classifyText("drop the quadratic term from the ranking formula. recommend b: delete the term.");
    expect(result.bucket).toBe("reserved");
    expect(result.rule).toBe("data_loss");
    expect(result.evidence).toEqual(["delete"]);
  });

  it("flags no_recommendation so the filer knows it is fixable by them", () => {
    const result = classifyText("shall i re-run the internal backfill script?");
    expect(result.bucket).toBe("no_recommendation");
    expect(result.evidence).toEqual([]);
  });
});

describe("applySiblingHold (port of _spread_reserved_within_issue)", () => {
  it("holds an otherwise-eligible card when a sibling is reserved", () => {
    const own = classifyText("re-run the internal budget-shift decomposition on the spend table. my pick: yes.");
    expect(own.bucket).toBe("internal_reversible");
    const held = applySiblingHold(own, ["reserved"]);
    expect(held).toEqual({ bucket: "reserved", rule: "sibling_reserved", evidence: [] });
  });

  it("holds when a sibling is merely ambiguous", () => {
    const own = classifyText("re-run the internal budget-shift decomposition on the spend table. my pick: yes.");
    const held = applySiblingHold(own, ["internal_reversible", "ambiguous"]);
    expect(held.bucket).toBe("reserved");
    expect(held.rule).toBe("sibling_reserved");
  });

  it("leaves an already-reserved card's own rule/evidence alone", () => {
    const own = classifyText("mint a new api key for the connector. recommend yes.");
    const held = applySiblingHold(own, ["internal_reversible"]);
    expect(held).toEqual(own);
  });

  it("does not hold when every sibling is internal_reversible or no_recommendation", () => {
    const own = classifyText("re-run the internal budget-shift decomposition on the spend table. my pick: yes.");
    const held = applySiblingHold(own, ["internal_reversible", "no_recommendation"]);
    expect(held).toEqual(own);
  });
});

describe("mayDefaultAct / computeDueAt", () => {
  it("only internal_reversible may default-act, and only it gets a dueAt", () => {
    expect(mayDefaultAct("internal_reversible")).toBe(true);
    expect(mayDefaultAct("reserved")).toBe(false);
    expect(mayDefaultAct("ambiguous")).toBe(false);
    expect(mayDefaultAct("no_recommendation")).toBe(false);
  });

  it("dueAt is createdAt + default_act_days, null otherwise", () => {
    const createdAt = new Date("2026-11-15T00:00:00Z");
    expect(computeDueAt("internal_reversible", createdAt)).toBe("2026-11-29T00:00:00.000Z");
    expect(computeDueAt("reserved", createdAt)).toBeNull();
    expect(computeDueAt("no_recommendation", createdAt)).toBeNull();
  });
});

// AC4 (partial — see PPC-7563 reasoning comment): true drift protection needs
// the cassandra-brain checkout, which GitHub Actions runners for this repo do
// not fetch today (no cross-repo checkout exists in .github/workflows/*).
// Every agent's own workspace DOES have cassandra-brain checked out per
// CLAUDE.md, so this enforces real freshness there and loudly no-ops
// elsewhere rather than silently claiming a CI gate that isn't wired yet.
describe("vendored rules freshness", () => {
  const brainPath = process.env.CASSANDRA_BRAIN_PATH ?? join(homedir(), "cassandra-brain");
  const classifierPath = join(brainPath, "scripts", "board_card_classifier.py");

  if (!existsSync(classifierPath)) {
    it.skip(`cassandra-brain not checked out at ${brainPath} — skipping live freshness check`, () => {});
  } else {
    it("matches a fresh --export-rules from cassandra-brain (regenerate with scripts/regen-default-act-rules.sh if this fails)", () => {
      const fresh = JSON.parse(execFileSync("python3", [classifierPath, "--export-rules"], { encoding: "utf8" }));
      expect(DEFAULT_ACT_RULES).toEqual(fresh);
    });
  }
});
