/**
 * Unit tests for src/cli/install-scan.ts — the install-time value-show
 * scan helpers. The scan itself spawns mine-local, which we mock at
 * the child_process boundary so tests stay fast and deterministic.
 *
 * Coverage targets: canOfferInstallScan guard chain (every false-path,
 * plus the all-conditions-met true-path); runInstallScan timeout +
 * happy path + manifest read; formatScanResult rendering invariants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync as existsSyncReal, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// child_process.spawn is mocked so the "scan" test doesn't actually
// invoke node — we drive child events from inside the test.
type SpawnCall = { cmd: string; args: string[] };
const spawnCalls: SpawnCall[] = [];
let nextChildBehavior: {
  exitCode?: number;
  emitError?: Error;
  delayMs?: number;
} = { exitCode: 0 };

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    const child = new EventEmitter() as any;
    child.kill = vi.fn();
    const behavior = nextChildBehavior;
    queueMicrotask(() => {
      const delay = behavior.delayMs ?? 0;
      const fire = () => {
        if (behavior.emitError) {
          child.emit("error", behavior.emitError);
        } else {
          child.emit("close", behavior.exitCode ?? 0);
        }
      };
      if (delay > 0) setTimeout(fire, delay);
      else fire();
    });
    return child;
  }),
}));

// findAgentBin returns a path that may or may not exist on disk — we
// drive it directly so tests don't depend on the developer's PATH.
let findAgentBinReturn: string | null = null;  // set in beforeEach
vi.mock("../../src/skillify/gate-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/skillify/gate-runner.js")>();
  return {
    ...actual,
    findAgentBin: (..._a: unknown[]) => findAgentBinReturn,
  };
});

// getLatestInsightEntry + countLocalManifestEntries are mocked so the
// runInstallScan path doesn't read the developer's real
// ~/.claude/hivemind/local-mined.json. Both accessors capture
// LOCAL_MANIFEST_PATH at module-load (homedir() at import time), so
// without these mocks tests would observe whatever is in the
// developer's real manifest.
let nextInsightEntry: any = null;
let nextSkillsCount = 0;
vi.mock("../../src/skillify/local-manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/skillify/local-manifest.js")>();
  return {
    ...actual,
    getLatestInsightEntry: () => nextInsightEntry,
    countLocalManifestEntries: () => nextSkillsCount,
    // canOfferInstallScan reads LOCAL_MANIFEST_PATH existence directly;
    // we keep the real export so tests can choose a tmp manifest path
    // by setting HOME via process.env.HOME below.
  };
});

// runAdvisor is mocked so install-scan tests stay focused on install-scan
// behavior. The advisor itself is tested in advisor.test.ts. Without this
// mock, every install-scan test would also exercise the advisor's spawn,
// inflating spawnCalls and breaking length assertions.
let nextAdvisorResult: any = null;
vi.mock("../../src/skillify/advisor.js", () => ({
  runAdvisor: vi.fn(async () => nextAdvisorResult),
}));

import {
  canOfferInstallScan,
  formatScanResult,
  runInstallScan,
} from "../../src/cli/install-scan.js";

const TMP_HOME = mkdtempSync(join(tmpdir(), "install-scan-test-"));
const originalHome = process.env.HOME;
const originalArgv1 = process.argv[1];
const FAKE_CLI = join(TMP_HOME, "fake-cli.js");
// Per-suite fake-bin path under TMP_HOME so parallel test files can't
// race on a shared /tmp/fake-claude-bin (coderabbit on PR #198).
const FAKE_BIN = join(TMP_HOME, "fake-claude-bin");

beforeEach(() => {
  // Reset state between tests.
  spawnCalls.length = 0;
  nextChildBehavior = { exitCode: 0 };
  findAgentBinReturn = FAKE_BIN;
  nextInsightEntry = null;
  nextSkillsCount = 0;
  nextAdvisorResult = null;
  // Each test starts with a clean tmp HOME: no sessions, no manifest.
  rmSync(TMP_HOME, { recursive: true, force: true });
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.HOME = TMP_HOME;
  // process.argv[1] is what runInstallScan spawns. Point it at a real
  // file so the existsSync check passes; the actual content doesn't
  // matter because spawn is mocked.
  writeFileSync(FAKE_CLI, "// fake cli", "utf-8");
  process.argv[1] = FAKE_CLI;
  // Also ensure the mocked "claude bin" exists on disk for the guard.
  writeFileSync(FAKE_BIN, "// fake claude", "utf-8");
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.argv[1] = originalArgv1;
  try { rmSync(FAKE_BIN); } catch { /* best-effort */ }
});

describe("canOfferInstallScan", () => {
  function seedSession(): void {
    const projectsDir = join(TMP_HOME, ".claude", "projects", "sample-proj");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, "abc.jsonl"), "{}\n", "utf-8");
  }

  it("returns false when no claude CLI is present (gate runner needs it)", () => {
    findAgentBinReturn = null;
    seedSession();
    expect(canOfferInstallScan()).toBe(false);
  });

  it("returns false when findAgentBin returns a path that doesn't exist", () => {
    findAgentBinReturn = "/nonexistent/claude";
    seedSession();
    expect(canOfferInstallScan()).toBe(false);
  });

  it("returns false when ~/.claude/projects is missing (truly fresh claude install)", () => {
    // No sessions seeded → cold-install path → no scan offer.
    expect(canOfferInstallScan()).toBe(false);
  });

  it("returns false when ~/.claude/projects exists but contains no .jsonl files", () => {
    // Subdir exists but is empty — the recursive scan finds nothing
    // and we don't waste user attention on a doomed offer.
    mkdirSync(join(TMP_HOME, ".claude", "projects", "empty"), { recursive: true });
    expect(canOfferInstallScan()).toBe(false);
  });

  it("returns false when the mine-local manifest already exists (re-installer)", () => {
    seedSession();
    const manifestDir = join(TMP_HOME, ".claude", "hivemind");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, "local-mined.json"), "{}\n", "utf-8");
    expect(canOfferInstallScan()).toBe(false);
  });

  it("returns true when all guards pass: claude CLI + sessions + no manifest", () => {
    seedSession();
    expect(canOfferInstallScan()).toBe(true);
  });
});

describe("runInstallScan", () => {
  it("spawns `skillify mine-local --n 10 --only claude_code` against the same CLI bundle the install ran from", async () => {
    nextChildBehavior = { exitCode: 0 };
    await runInstallScan();
    expect(spawnCalls).toHaveLength(1);
    const { cmd, args } = spawnCalls[0];
    expect(cmd).toBe(process.execPath);
    // Always spawns OUR cli bundle, never `which hivemind`, so the
    // worker is the same version as the parent install process.
    expect(args[0]).toBe(FAKE_CLI);
    expect(args).toContain("skillify");
    expect(args).toContain("mine-local");
    // `--n 10` is the install-time session cap. Tuned across
    // iterations (3 → 5 → 20 → 10) with real-data latency + quality
    // measurements: 10 is the sweet spot — concurrency=4 caps
    // parallelism so the curve flattens past N≈10, and advisor pick
    // quality at N=10 matches N=20 in practice.
    expect(args).toContain("--n");
    expect(args[args.indexOf("--n") + 1]).toBe("10");
    // `--only claude_code` honors the "scan your Claude Code sessions"
    // copy — without it, mine-local would walk every installed agent
    // and could surface an insight from Codex / Cursor (codex PR #198
    // P2). Regression guard.
    expect(args).toContain("--only");
    expect(args[args.indexOf("--only") + 1]).toBe("claude_code");
  });

  it("deletes the manifest when mine-local wrote a literal empty sentinel (entries: [])", async () => {
    // codex PR #198 P1: mine-local writes a sentinel manifest even
    // when 0 SKILLS were found. That sentinel permanently disables
    // future maybeAutoMineLocal() runs. We unlink it so background
    // mining can retry as history accumulates.
    const manifestPath = join(TMP_HOME, ".claude", "hivemind", "local-mined.json");
    mkdirSync(join(TMP_HOME, ".claude", "hivemind"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ created_at: "x", entries: [] }));
    nextChildBehavior = { exitCode: 0 };
    nextInsightEntry = null;
    const result = await runInstallScan();
    expect(result.insight).toBeNull();
    // Manifest is gone — background auto-mine can retry.
    expect(existsSyncReal(manifestPath)).toBe(false);
  });

  it("suppresses insight when advisor REJECT_ALLs even if a recency-pick would otherwise exist (codex P2)", async () => {
    // Regression guard for codex's third-round P2: if sonnet returns
    // REJECT_ALL, runAdvisor's pickedSkillName is null. Without the
    // suppression check, runInstallScan would still fall through to
    // getLatestInsightEntry() and surface the exact candidate the
    // advisor just rejected — defeating the advisor pass entirely.
    nextChildBehavior = { exitCode: 0 };
    nextInsightEntry = {
      skill_name: "rejected-meta-noise",
      insight: "User explicitly requested this rule be saved.",
      created_at: "2026-05-22T00:00:00.000Z",
    };
    nextSkillsCount = 3;
    nextAdvisorResult = { pickedSkillName: null, reason: "REJECT_ALL: all meta-noise", rawOutput: "" };
    const result = await runInstallScan();
    expect(result.insight).toBeNull();
    // Skills count still surfaces — the caller can show "mined N skills"
    // copy instead of either the rejected insight or "no patterns found."
    expect(result.skillsCount).toBe(3);
  });

  it("uses the recency pick when advisor returns null (no candidates / no CLI / no manifest)", async () => {
    // Distinguishes the REJECT_ALL case (advisor evaluated and said no)
    // from the no-opinion case (advisor didn't run). When advisor itself
    // returned null, we trust the recency tiebreak.
    nextChildBehavior = { exitCode: 0 };
    nextInsightEntry = {
      skill_name: "concrete-pattern",
      insight: "You hit X twice last week.",
      created_at: "2026-05-22T00:00:00.000Z",
    };
    nextSkillsCount = 1;
    nextAdvisorResult = null;  // advisor didn't run at all
    const result = await runInstallScan();
    expect(result.insight).not.toBeNull();
    expect(result.insight!.skill_name).toBe("concrete-pattern");
  });

  it("returns skillsCount > 0 when mine-local wrote skills but no insight surfaced (codex P3)", async () => {
    // Regression guard for codex P3: caller used to see `null` from
    // runInstallScan and print "No repeatable patterns found" even
    // when skills WERE mined. The new shape carries skillsCount so
    // the caller can distinguish "scan failed" from "skills mined
    // but no banner-quality insight."
    const manifestPath = join(TMP_HOME, ".claude", "hivemind", "local-mined.json");
    mkdirSync(join(TMP_HOME, ".claude", "hivemind"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({
      created_at: "x",
      entries: [
        { skill_name: "a", canonical_path: "/x", symlinks: [], source_session_ids: [], source_session_paths: [], source_agent: "claude_code", gate_agent: "claude_code", created_at: "2026-05-22T00:00:00.000Z", uploaded: false },
        { skill_name: "b", canonical_path: "/x", symlinks: [], source_session_ids: [], source_session_paths: [], source_agent: "claude_code", gate_agent: "claude_code", created_at: "2026-05-22T00:00:01.000Z", uploaded: false },
      ],
    }));
    nextChildBehavior = { exitCode: 0 };
    nextInsightEntry = null;
    nextSkillsCount = 2;
    const result = await runInstallScan();
    expect(result.insight).toBeNull();
    expect(result.skillsCount).toBe(2);
  });

  it("unlinks a corrupt/truncated manifest left behind on timeout (codex P2)", async () => {
    // Regression guard for codex P2: a timeout/crash mid-write can
    // leave the manifest unparseable. Both canOfferInstallScan and
    // maybeAutoMineLocal treat presence as "already mined", so a
    // corrupt sentinel would permanently disable retries.
    const manifestPath = join(TMP_HOME, ".claude", "hivemind", "local-mined.json");
    mkdirSync(join(TMP_HOME, ".claude", "hivemind"), { recursive: true });
    writeFileSync(manifestPath, "{ truncated json — not closed");
    nextChildBehavior = { exitCode: 1 };  // simulate child crash
    nextInsightEntry = null;
    const result = await runInstallScan();
    expect(result.insight).toBeNull();
    // Corrupt manifest unlinked — future retries can fire.
    expect(existsSyncReal(manifestPath)).toBe(false);
  });

  it("PRESERVES the manifest when mine-local wrote skills but none have an insight (codex P2)", async () => {
    // codex PR #198 P2: the prior fix was over-aggressive. When
    // mine-local writes skills (entries.length > 0) but the gate
    // omits `insight` on every one of them, we MUST NOT delete the
    // manifest — countLocalManifestEntries() surfaces the count via
    // the legacy SessionStart banner branch, and a future
    // `push-local` needs the row metadata. Only the literal
    // `entries: []` sentinel should be cleared.
    const manifestPath = join(TMP_HOME, ".claude", "hivemind", "local-mined.json");
    mkdirSync(join(TMP_HOME, ".claude", "hivemind"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({
      created_at: "x",
      entries: [
        { skill_name: "a", canonical_path: "/x", symlinks: [], source_session_ids: [], source_session_paths: [], source_agent: "claude_code", gate_agent: "claude_code", created_at: "2026-05-22T00:00:00.000Z", uploaded: false },
      ],
    }));
    nextChildBehavior = { exitCode: 0 };
    nextInsightEntry = null;  // no insight produced, but skills exist
    const result = await runInstallScan();
    expect(result.insight).toBeNull();
    expect(existsSyncReal(manifestPath)).toBe(true);
  });

  it("preserves the manifest when an insight WAS produced", async () => {
    const manifestPath = join(TMP_HOME, ".claude", "hivemind", "local-mined.json");
    mkdirSync(join(TMP_HOME, ".claude", "hivemind"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({
      created_at: "x",
      entries: [{ skill_name: "k", insight: "i", created_at: "z" }],
    }));
    nextChildBehavior = { exitCode: 0 };
    nextInsightEntry = { skill_name: "k", insight: "i", created_at: "z" };
    const result = await runInstallScan();
    expect(result.insight).not.toBeNull();
    expect(existsSyncReal(manifestPath)).toBe(true);
  });

  it("resolves with the latest insight entry on clean exit when one exists", async () => {
    nextInsightEntry = {
      skill_name: "verify-before-done",
      insight: "You revisited 4 merged PRs in the last month.",
      created_at: "2026-05-22T10:00:00.000Z",
    };
    nextChildBehavior = { exitCode: 0 };
    const result = await runInstallScan();
    expect(result.insight).not.toBeNull();
    expect(result.insight!.skill_name).toBe("verify-before-done");
  });

  it("resolves with null on non-zero exit", async () => {
    nextChildBehavior = { exitCode: 1 };
    nextInsightEntry = { skill_name: "x", insight: "y", created_at: "z" };
    // Even if a manifest exists, a failed mine-local run shouldn't
    // surface its (possibly stale) output. We treat non-zero exit as
    // "scan failed → fall through silently".
    const result = await runInstallScan();
    expect(result.insight).toBeNull();
  });

  it("resolves with null on spawn error", async () => {
    nextChildBehavior = { emitError: new Error("ENOENT") };
    const result = await runInstallScan();
    expect(result.insight).toBeNull();
  });

  it("resolves with null when process.argv[1] points at a missing file (safety guard)", async () => {
    process.argv[1] = "/nonexistent/cli.js";
    const result = await runInstallScan();
    // Spawn should NOT have been called — we bail out at the
    // existsSync check rather than letting node fail mid-spawn.
    expect(result.insight).toBeNull();
    expect(spawnCalls).toHaveLength(0);
  });

  it("resolves with null when getLatestInsightEntry returns null (gate produced no insight)", async () => {
    nextChildBehavior = { exitCode: 0 };
    nextInsightEntry = null;
    const result = await runInstallScan();
    expect(result.insight).toBeNull();
  });
});

describe("formatScanResult", () => {
  function makeEntry(insight: string, name = "verify-before-done"): any {
    return {
      skill_name: name,
      insight,
      created_at: "2026-05-22T00:00:00.000Z",
    };
  }

  it("renders insight, skill name, and emoji markers", () => {
    const out = formatScanResult(makeEntry("You revisited 4 merged PRs."));
    expect(out).toContain("Found a pattern in your past sessions");
    expect(out).toContain("📌 You revisited 4 merged PRs.");
    expect(out).toContain("✨ Skill `verify-before-done` ready");
  });

  it("collapses embedded whitespace (newlines, tabs) to single spaces", () => {
    // Defense-in-depth: parseMultiVerdict already normalizes whitespace
    // before persistence, but this renderer is the last guard before
    // user-visible output and must not blindly trust the input.
    const out = formatScanResult(makeEntry("Line one.\nLine\ttwo.   Three."));
    expect(out).toContain("📌 Line one. Line two. Three.");
    expect(out).not.toContain("\nLine two");
    expect(out).not.toContain("\t");
  });

  it("truncates insight over 280 chars at a word boundary with ellipsis", () => {
    // 280-char cap matches the parseMultiVerdict storage cap, so the
    // renderer never truncates beyond what the manifest can store.
    // Bumped from 200 → 280 after a real-world test caught a haiku
    // insight mid-sentence at 200; 280 gives haiku room to finish a
    // single sentence with the punchline intact.
    const long = "x ".repeat(280).trim() + " end-marker";
    const out = formatScanResult(makeEntry(long));
    const insightLine = out.split("\n").find(l => l.includes("📌"))!;
    // Allow ~10 chars of slack for the emoji + leading spaces.
    expect(insightLine.length).toBeLessThanOrEqual(295);
    expect(insightLine.endsWith("…")).toBe(true);
    expect(insightLine).not.toContain("end-marker");
  });

  it("passes through short insights without truncation", () => {
    const out = formatScanResult(makeEntry("Short and concrete."));
    expect(out).toContain("Short and concrete.");
    expect(out).not.toContain("…");
  });

  it("handles missing insight gracefully (empty string, not crash)", () => {
    // Should never happen in practice — caller checks for non-empty
    // insight before calling formatScanResult — but defensive coding
    // means a malformed entry doesn't crash the install.
    const out = formatScanResult({
      skill_name: "x",
      insight: undefined as any,
      created_at: "z",
    } as any);
    expect(out).toContain("📌");
    expect(out).toContain("✨ Skill `x`");
  });
});
