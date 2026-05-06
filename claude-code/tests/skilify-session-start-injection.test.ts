import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Bundle-level guard: every agent's session-start.js bundle must inject the
 * SKILLS (skilify) section into the agent's developer context. Skilify
 * commands are part of the same hivemind family as the auth-login subcommands
 * — without this injection, agents have no way to discover that
 * `hivemind skilify pull --user X`, `--to global`, `--dry-run`, etc. exist.
 *
 * Each session-start.ts source file embeds the SKILLS section as a literal
 * string and resolves the HIVEMIND_CLI placeholder to the absolute path of
 * `bundle/cli.js` at runtime. These assertions catch any future refactor
 * that drops the injection or breaks the placeholder substitution.
 */

const BUNDLE_ROOT = resolve(__dirname, "..", "..");

const SESSION_START_BUNDLES: Array<[string, string]> = [
  ["claude-code", resolve(BUNDLE_ROOT, "claude-code", "bundle", "session-start.js")],
  ["codex",       resolve(BUNDLE_ROOT, "codex",       "bundle", "session-start.js")],
  ["cursor",      resolve(BUNDLE_ROOT, "cursor",      "bundle", "session-start.js")],
  ["hermes",      resolve(BUNDLE_ROOT, "hermes",      "bundle", "session-start.js")],
];

describe("skilify SessionStart injection (per-agent bundles)", () => {
  it.each(SESSION_START_BUNDLES)("%s bundle exists", (_label, p) => {
    expect(existsSync(p)).toBe(true);
  });

  it.each(SESSION_START_BUNDLES)(
    "%s bundle includes the SKILLS / Skill management section",
    (_label, p) => {
      const text = readFileSync(p, "utf-8");
      // Claude Code uses the long header "Skill management"; the others use
      // the short "SKILLS (skilify)" header. Either is acceptable.
      const hasHeader =
        text.includes("Skill management") || text.includes("SKILLS (skilify)");
      expect(hasHeader).toBe(true);
    }
  );

  it.each(SESSION_START_BUNDLES)(
    "%s bundle advertises the high-value skilify pull invocations",
    (_label, p) => {
      const text = readFileSync(p, "utf-8");
      // The exact subcommands every agent must surface to be useful.
      expect(text).toMatch(/skilify pull/);
      expect(text).toMatch(/skilify pull --user/);
      expect(text).toMatch(/skilify pull --users/);
      expect(text).toMatch(/skilify pull --all-users/);
      expect(text).toMatch(/skilify pull --dry-run/);
      expect(text).toMatch(/skilify scope/);
      expect(text).toMatch(/skilify team/);
    }
  );

  it.each(SESSION_START_BUNDLES)(
    "%s bundle resolves HIVEMIND_CLI placeholder (no literal placeholder leaks at runtime)",
    (_label, p) => {
      const text = readFileSync(p, "utf-8");
      // The bundle must contain the string `HIVEMIND_CLI` ONLY in two contexts:
      //   1. The const declaration (`const HIVEMIND_CLI = join(...)`).
      //   2. The substitution call (`replace(/HIVEMIND_CLI/g, HIVEMIND_CLI)`).
      // It must NOT appear inside a quoted template-string segment that would
      // ship to the agent verbatim. We assert that `replace` is wired up so
      // any literal occurrence in the inject string gets substituted.
      expect(text).toMatch(/replace\(\s*\/HIVEMIND_CLI\/g\s*,\s*HIVEMIND_CLI\s*\)/);
      // esbuild emits `var HIVEMIND_CLI = ...` (it does not preserve const).
      expect(text).toMatch(/(?:var|const|let)\s+HIVEMIND_CLI\s*=/);
      // The const must resolve to the unified hivemind dispatcher one level
      // above each agent's bundle dir: <root>/<agent>/bundle/../../bundle/cli.js
      expect(text).toMatch(/HIVEMIND_CLI\s*=\s*join\d*\(\s*__bundleDir\s*,\s*"\.\.",\s*"\.\.",\s*"bundle",\s*"cli\.js"\s*\)/);
    }
  );
});

describe("hivemind CLI USAGE help advertises skilify", () => {
  // Source-of-truth scan: USAGE block in src/cli/index.ts must list skilify.
  // Bundle scan would also work but the source is canonical for help text.
  it("`hivemind --help` documents the skilify subcommand family", () => {
    const cli = resolve(BUNDLE_ROOT, "bundle", "cli.js");
    const text = readFileSync(cli, "utf-8");
    expect(text).toMatch(/Skill management/);
    expect(text).toMatch(/hivemind skilify pull/);
    expect(text).toMatch(/hivemind skilify scope/);
    expect(text).toMatch(/hivemind skilify team/);
  });
});
