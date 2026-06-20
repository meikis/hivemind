import { describe, it, expect } from "vitest";
import {
  shouldRecall,
  passesThreshold,
  RECALL_THRESHOLD,
} from "../../src/hooks/shared/recall-gate.js";
import {
  parseSummaryPath,
  daysAgo,
  formatRecallContext,
  type RecallHit,
} from "../../src/hooks/shared/recall-format.js";
import { recallTopHit } from "../../src/hooks/shared/recall-query.js";

describe("shouldRecall — the precision gate (NOT every prompt)", () => {
  it("skips short acknowledgements / continuations", () => {
    for (const p of ["yes", "ok", "go on", "continue", "fix it", "run the tests", "thanks", "retry", "do it"]) {
      expect(shouldRecall(p).recall, p).toBe(false);
    }
  });

  it("skips empty / very short prompts", () => {
    expect(shouldRecall("").recall).toBe(false);
    expect(shouldRecall("   ").recall).toBe(false);
    expect(shouldRecall("add log").reason).toBe("too-short");
  });

  it("recalls on error / failure / stack-trace signals", () => {
    for (const p of [
      "I'm getting a TypeError when I call the parser",
      "the build fails with cannot find module foo",
      "segfault in column_streamers.hpp:142 on scan",
      "why does this throw an exception on startup",
    ]) {
      const d = shouldRecall(p);
      expect(d.recall, p).toBe(true);
      expect(d.reason).toBe("signal");
    }
  });

  it("recalls on recall/how-to intent", () => {
    expect(shouldRecall("how did we fix the auth token drift last time?").reason).toBe("signal");
    expect(shouldRecall("do we have a known issue with the redis cache here").reason).toBe("signal");
  });

  it("recalls on substantive prose with no explicit marker", () => {
    const d = shouldRecall("please refactor the storage provider to support byoc buckets cleanly");
    expect(d.recall).toBe(true);
    expect(d.reason).toBe("substantive");
  });

  it("skips terse low-signal instructions", () => {
    expect(shouldRecall("rename that variable").recall).toBe(false);
    expect(shouldRecall("bump the version number").recall).toBe(false);
  });
});

describe("passesThreshold", () => {
  it("gates on the cosine score", () => {
    expect(passesThreshold(RECALL_THRESHOLD)).toBe(true);
    expect(passesThreshold(RECALL_THRESHOLD - 0.01)).toBe(false);
    expect(passesThreshold(0.99)).toBe(true);
    expect(passesThreshold(NaN)).toBe(false);
  });
});

describe("parseSummaryPath", () => {
  it("extracts author + session from a summary path", () => {
    expect(parseSummaryPath("/summaries/levon/session-abc.md")).toEqual({ author: "levon", session: "session-abc" });
  });
  it("returns null for non-summary paths", () => {
    expect(parseSummaryPath("/sessions/levon/foo.jsonl")).toBeNull();
    expect(parseSummaryPath("garbage")).toBeNull();
  });
});

describe("daysAgo", () => {
  const now = Date.parse("2026-06-20T12:00:00Z");
  it("computes whole days, floored at 0", () => {
    expect(daysAgo("2026-06-20T00:00:00Z", now)).toBe(0);
    expect(daysAgo("2026-06-19T00:00:00Z", now)).toBe(1);
    expect(daysAgo("2026-06-13T12:00:00Z", now)).toBe(7);
    expect(daysAgo("2999-01-01T00:00:00Z", now)).toBe(0); // future clamps to 0
  });
  it("returns null for unparseable dates", () => {
    expect(daysAgo("not-a-date", now)).toBeNull();
  });
});

describe("formatRecallContext", () => {
  const now = Date.parse("2026-06-20T12:00:00Z");
  const base: RecallHit = {
    path: "/summaries/levon/sess-1.md",
    author: "levon",
    project: "indra",
    description: "Fixed pg-deeplake SIGSEGV on sessions scan via row-count clamp",
    lastUpdate: "2026-06-18T00:00:00Z",
    score: 0.71,
  };

  it("attributes a teammate's hit with relative date + project", () => {
    const out = formatRecallContext({ hit: base, currentUser: "sasun", now });
    expect(out).toContain("HIVEMIND RECALL");
    expect(out).toContain("levon"); // teammate name surfaced
    expect(out).toContain("2d ago");
    expect(out).toContain("indra");
    expect(out).toContain("Fixed pg-deeplake SIGSEGV");
    expect(out).toContain("cat ~/.deeplake/memory/summaries/levon/sess-1.md");
  });

  it("says 'you' when the hit is the current user's own work", () => {
    const out = formatRecallContext({ hit: base, currentUser: "levon", now });
    expect(out).toContain("you");
    expect(out).not.toMatch(/•\s+levon/);
  });

  it("returns empty string for an unattributable path (never inject unattributed)", () => {
    const out = formatRecallContext({ hit: { ...base, path: "/sessions/x/y.jsonl" }, currentUser: "sasun", now });
    expect(out).toBe("");
  });

  it("frames the block as context, not an instruction (prompt-injection hygiene)", () => {
    const out = formatRecallContext({ hit: base, currentUser: "sasun", now });
    expect(out.toLowerCase()).toContain("not an instruction");
  });
});

describe("recallTopHit — focused semantic query", () => {
  const vec = [0.1, 0.2, 0.3];

  it("builds a cosine-ranked query over the memory table and maps the top row", async () => {
    let captured = "";
    const query = async (sql: string) => {
      captured = sql;
      return [{
        path: "/summaries/levon/s1.md", author: "levon", project: "indra",
        description: "desc", last_update_date: "2026-06-18", score: 0.8,
      }];
    };
    const hit = await recallTopHit(query, "org_memory", vec, { excludePath: "/summaries/sasun/mine.md", limit: 3 });
    expect(captured).toContain("summary_embedding <#> ARRAY[");
    expect(captured).toContain('FROM "org_memory"');
    expect(captured).toContain("ARRAY_LENGTH(summary_embedding, 1) > 0");
    expect(captured).toContain("path <> '/summaries/sasun/mine.md'");
    expect(captured).toContain("ORDER BY score DESC LIMIT 3");
    expect(hit).toMatchObject({ author: "levon", project: "indra", score: 0.8 });
  });

  it("returns null when no rows match", async () => {
    const hit = await recallTopHit(async () => [], "t", vec, {});
    expect(hit).toBeNull();
  });

  it("returns null for a non-finite embedding (never builds a NULL-vector query)", async () => {
    let called = false;
    const hit = await recallTopHit(async () => { called = true; return []; }, "t", [0.1, NaN], {});
    expect(hit).toBeNull();
    expect(called).toBe(false);
  });
});
