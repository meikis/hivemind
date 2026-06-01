import { describe, it, expect } from "vitest";
import {
  extractNextSteps,
  isPlaceholderSummary,
  selectRealSummaries,
} from "../../src/notifications/sources/resume-brief.js";

// Fixture mirrors the wiki-summary shape: `# Session` title, metadata, then
// the ## sections including the new `## Next Steps`.
function summary(opts: { next?: string; open?: string; whatHappened?: string } = {}): string {
  let s = `# Session abc\n- **Project**: indra\n\n## What Happened\n${opts.whatHappened ?? "Did stuff."}\n`;
  if (opts.open !== undefined) s += `\n## Open Questions / TODO\n${opts.open}\n`;
  if (opts.next !== undefined) s += `\n## Next Steps\n${opts.next}\n`;
  return s;
}

describe("extractNextSteps", () => {
  it("prefers the ## Next Steps section", () => {
    const s = summary({ next: "Wire the resume fallback and run tests", open: "- something else" });
    expect(extractNextSteps(s)).toBe("Wire the resume fallback and run tests");
  });

  it("falls back to ## Open Questions / TODO when Next Steps is absent (older summaries)", () => {
    const s = summary({ open: "- Verify the header parse on Windows" });
    expect(extractNextSteps(s)).toBe("Verify the header parse on Windows");
  });

  it("strips a leading bullet marker", () => {
    expect(extractNextSteps(summary({ next: "- Ship the PR" }))).toBe("Ship the PR");
  });

  it("treats an explicit 'none' Next Steps as wrapped-clean (empty)", () => {
    expect(extractNextSteps(summary({ next: "none" }))).toBe("");
    expect(extractNextSteps(summary({ next: "None." }))).toBe("");
    expect(extractNextSteps(summary({ next: "N/A" }))).toBe("");
  });

  it("returns '' when neither section is present", () => {
    expect(extractNextSteps(summary({ whatHappened: "Just chatted." }))).toBe("");
  });

  it("returns '' for an empty section body", () => {
    expect(extractNextSteps(summary({ next: "" }))).toBe("");
  });

  it("takes the first real line of a multi-line section", () => {
    expect(extractNextSteps(summary({ next: "Finish the migration\nThen write docs" })))
      .toBe("Finish the migration");
  });
});

// A SessionStart placeholder: metadata skeleton, no `## ` content section
// (the real shape that was shadowing summaries in prod).
const PLACEHOLDER =
  "# Session d3c21026\n- **Source**: /sessions/sasun/x.jsonl\n- **Started**: 2026-05-31T17:09:02.539Z\n- **Project**: hivemind\n- **Status**: in-progress\n";

describe("isPlaceholderSummary", () => {
  it("flags a SessionStart skeleton (no ## section)", () => {
    expect(isPlaceholderSummary(PLACEHOLDER)).toBe(true);
  });
  it("does not flag a real summary with ## sections", () => {
    expect(isPlaceholderSummary(summary({ open: "- do the thing" }))).toBe(false);
  });
});

describe("selectRealSummaries (windowing)", () => {
  it("skips placeholders so the walk-back reaches the real summary underneath", () => {
    const real = summary({ open: "- Re-run CI on f89e70e" });
    const rows = [
      { summary: PLACEHOLDER, path: "/s/new.md", last_update_date: "2026-06-01" },
      { summary: PLACEHOLDER, path: "/s/new2.md", last_update_date: "2026-05-31" },
      { summary: real, path: "/s/real.md", last_update_date: "2026-05-27" },
    ];
    const reals = selectRealSummaries(rows);
    expect(reals).toHaveLength(1);
    expect(extractNextSteps(reals[0].summary)).toBe("Re-run CI on f89e70e");
    expect(reals[0].date).toBe("2026-05-27");
  });

  it("dedups duplicate rows for the same session by path", () => {
    const real = summary({ open: "- ship it" });
    const rows = [
      { summary: real, path: "/s/a.md", last_update_date: "2026-05-27" },
      { summary: real, path: "/s/a.md", last_update_date: "2026-05-27" }, // duplicate
    ];
    expect(selectRealSummaries(rows)).toHaveLength(1);
  });

  it("returns nothing when every row is a placeholder (caller renders plain welcome, not 'wrapped clean')", () => {
    const rows = [
      { summary: PLACEHOLDER, path: "/s/1.md", last_update_date: "2026-06-01" },
      { summary: PLACEHOLDER, path: "/s/2.md", last_update_date: "2026-05-31" },
    ];
    expect(selectRealSummaries(rows)).toEqual([]);
  });

  it("caps at the lookback after filtering", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      summary: summary({ open: `- task ${i}` }),
      path: `/s/${i}.md`,
      last_update_date: `2026-05-${20 + i}`,
    }));
    expect(selectRealSummaries(rows, 5)).toHaveLength(5);
  });
});
