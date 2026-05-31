import { describe, it, expect } from "vitest";
import { extractNextSteps } from "../../src/notifications/sources/resume-brief.js";

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
