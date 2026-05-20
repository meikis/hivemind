/**
 * Existing-user autoupdate lifecycle: install an OLDER version of
 * hivemind from npm → run an agent → session-start's autoupdate code
 * path detects a newer published version, dispatches a detached upgrade
 * → assert the prefix's installed version is now the registry's latest.
 *
 * This simulates the exact scenario a user hits when they upgrade: the
 * old plugin loads at session start, fires `hivemind update` in the
 * background, and the next session picks up the new code. A regression
 * that breaks this flow — for example, an autoupdate-side env-var rename
 * that means the spawn-detached child runs `node missing-script.js` —
 * wouldn't surface in cases 01-19 (they all start clean and the
 * autoupdate code path detects "no update needed").
 *
 * Why the target is "registry latest" not "worktree version": the
 * autoupdate code path goes through the npm registry, so it lands
 * whatever `latest` resolves to at run time. On a feature branch the
 * worktree's package.json may be behind `latest` (PRs commonly are);
 * anchoring on the worktree version would false-negative every run.
 * Anchor on what autoupdate ACTUALLY produces — registry latest — and
 * resolve it at assertion time so the test self-updates as releases ship.
 *
 * Why network-pull instead of a pinned fixture: the npm registry IS the
 * authoritative artifact source; a fixture would drift. Pinning
 * `OLD_VERSION` keeps the baseline deterministic; we bump it manually
 * (downward only — must stay strictly behind latest). The fetch is one
 * `npm pack @deeplake/hivemind@X.Y.Z` call; offline dev hits this case
 * as a clean error with a "registry unreachable" message, not a flake.
 */

import { mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { E2ECase } from "../types.js";

const OLD_VERSION = "0.7.30";

const existingUserAutoupdateCase: E2ECase = {
  id: "20-existing-user-autoupdate",
  description:
    `pre-install hivemind@${OLD_VERSION} into a tmp prefix → spawn agent → session-start autoupdate detaches a child that upgrades the prefix to the worktree's current version. Verifies the autoupdate flow doesn't break the in-flight session AND lands the new bundle.`,
  prompt: "Reply with the single word 'upgraded' and stop. Do not call tools.",
  async setup(ctx) {
    const prefix = join(ctx.home, ".npm-prefix");
    const cacheDir = join(ctx.home, ".npm-cache");
    mkdirSync(prefix, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });

    // Step 1: fetch the OLD version's tarball from the registry. We use
    // `npm pack @deeplake/hivemind@OLD_VERSION` which downloads and
    // writes a .tgz to packDir. This is the same path real users hit
    // when they ran `npm install -g @deeplake/hivemind` at OLD_VERSION's
    // release time.
    const packDir = join(ctx.home, ".pack");
    mkdirSync(packDir, { recursive: true });
    execFileSync(
      "npm",
      ["pack", `@deeplake/hivemind@${OLD_VERSION}`, "--pack-destination", packDir],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: { ...process.env, npm_config_cache: cacheDir, npm_config_loglevel: "error" } },
    );
    const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
    if (tarballs.length === 0) throw new Error(`npm pack @deeplake/hivemind@${OLD_VERSION} produced no .tgz`);

    // Step 2: install OLD_VERSION into the tmp prefix.
    execFileSync(
      "npm",
      ["install", "-g", join(packDir, tarballs[0]), "--prefix", prefix, "--no-fund", "--no-audit", "--ignore-scripts"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, env: { ...process.env, npm_config_cache: cacheDir, npm_config_loglevel: "error" } },
    );

    // Step 3: also install hivemind into the tmp HOME's claude plugin
    // location via the OLD_VERSION's CLI. After this, the tmp HOME has
    // an OLD_VERSION install of hivemind ready to fire session-start.
    const hivemindBin = join(prefix, "bin", "hivemind");
    if (!existsSync(hivemindBin)) throw new Error(`${hivemindBin} missing after install -g`);
    // Use codex slot for the agent run (case 13 already uses claude-code
    // for npm-pack; avoid stomping on its prefix layout).
    execFileSync(hivemindBin, ["codex", "install"], {
      env: { ...process.env, HOME: ctx.home, PATH: `${join(prefix, "bin")}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });

    // Sanity: confirm OLD_VERSION's bundle is what the tmp HOME has now.
    // (The autoupdate assertion later compares this against the worktree
    // version — they must differ for the test to mean anything.)
    const oldBundlePkg = join(ctx.home, ".codex", "hivemind", "bundle", "package.json");
    if (existsSync(oldBundlePkg)) {
      const pkg = JSON.parse(readFileSync(oldBundlePkg, "utf-8"));
      if (pkg.version !== OLD_VERSION) {
        throw new Error(`bundle/package.json reports ${pkg.version}, expected ${OLD_VERSION} (npm install -g landed a different version)`);
      }
    }

    // Stash the prefix path for the assertion to read back.
    process.env.HIVEMIND_E2E_TMP_PREFIX = prefix;

    // The agent run happens via the driver. The driver's spawn inherits
    // process.env, including PATH — which we extend with the prefix's
    // bin/ so the session-start hook's autoupdate code path can resolve
    // `hivemind` to OUR prefix-installed version (the one we want to see
    // upgraded), not whatever's on the host's PATH.
    process.env.PATH = `${join(prefix, "bin")}:${process.env.PATH ?? ""}`;
  },
  assertions: [
    {
      type: "custom",
      label: `autoupdate landed the registry's current latest into ${OLD_VERSION}'s prefix`,
      check: async ({ ctx }) => {
        const prefix = process.env.HIVEMIND_E2E_TMP_PREFIX;
        if (!prefix) return "tmp prefix env var lost between setup and assertion";

        // Resolve "latest published" at assertion time, NOT from the
        // worktree's package.json. The autoupdate code path goes through
        // the npm registry, so it lands whatever `latest` resolves to at
        // run time — which may differ from the worktree's version (the
        // worktree is the PR branch; latest may be ahead of or behind it).
        // Anchoring on the worktree version creates a false-negative when
        // the registry is ahead, which is the normal state during a PR.
        let latestVersion: string;
        try {
          latestVersion = execFileSync("npm", ["view", "@deeplake/hivemind", "version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).toString().trim();
        } catch (e) {
          return `cannot resolve @deeplake/hivemind latest from registry: ${e instanceof Error ? e.message : String(e)}. Test cannot proceed without a known target version.`;
        }
        if (latestVersion === OLD_VERSION) {
          // OLD_VERSION should be strictly behind latest, otherwise the
          // test has no delta to assert on (autoupdate would be a no-op).
          return `OLD_VERSION (${OLD_VERSION}) is the same as registry latest; nothing to upgrade to. Bump OLD_VERSION downward or pick a different baseline.`;
        }

        // Autoupdate is fire-and-forget detached. Give it up to 60s to
        // finish the npm install -g and replace the prefix bundle. Poll
        // the prefix's package.json until it shows the latest version
        // (or the poll times out).
        const installedPkg = join(prefix, "lib", "node_modules", "@deeplake", "hivemind", "package.json");
        const deadline = Date.now() + 60_000;
        let lastSeen = OLD_VERSION;
        while (Date.now() < deadline) {
          if (existsSync(installedPkg)) {
            try {
              const pkg = JSON.parse(readFileSync(installedPkg, "utf-8"));
              if (typeof pkg.version === "string") {
                lastSeen = pkg.version;
                if (pkg.version === latestVersion) return null;
              }
            } catch { /* mid-install partial JSON; retry */ }
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        // Cleanup the env stash regardless of outcome.
        delete process.env.HIVEMIND_E2E_TMP_PREFIX;
        return `autoupdate did not replace ${OLD_VERSION} with ${latestVersion} within 60s. lastSeen=${lastSeen}. ${ctx.agent}'s session-start fired the detached upgrade but it either crashed silently, was blocked by registry routing, or the autoupdate code path in ${OLD_VERSION} has a known regression. Check ~/.deeplake/hook-debug.log for [autoupdate] markers.`;
      },
    },
  ],
  // Codex single-runner (autoupdate is agent-independent — any one agent
  // exercises the code path; running all 6 is redundant npm I/O).
  skipFor: ["claude-code", "cursor-agent", "hermes", "pi", "openclaw"],
};

export default existingUserAutoupdateCase;
