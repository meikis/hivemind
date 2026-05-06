#!/usr/bin/env node

/**
 * Codex SessionStart hook (fast path):
 * Only reads local credentials and injects context into Codex's developer prompt.
 * All server calls (table setup, placeholder, version check) are handled by
 * session-start-setup.js which runs as a separate async hook.
 *
 * Codex input:  { session_id, transcript_path, cwd, hook_event_name, model, source }
 * Codex output: plain text on stdout (added as developer context)
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials } from "../../commands/auth.js";
import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import { getInstalledVersion } from "../../utils/version-check.js";
const log = (msg: string) => _log("codex-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const AUTH_CMD = join(__bundleDir, "commands", "auth-login.js");
const HIVEMIND_CLI = join(__bundleDir, "..", "..", "bundle", "cli.js");

const context = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Deeplake memory has THREE tiers — pick the right one for the question:
1. ~/.deeplake/memory/index.md   — auto-generated index, top 50 most-recently-updated entries with Created + Last Updated + Project + Description columns. ~5 KB. **For "what's recent / who did X this week / since <date>" queries, START HERE** and trust the Last Updated column over any "Started:" line in summary bodies.
2. ~/.deeplake/memory/summaries/ — condensed wiki summaries per session (~3 KB each). For keyword/topic recall, search these.
3. ~/.deeplake/memory/sessions/  — raw full-dialogue JSONL (~5 KB each). FALLBACK only — use when summaries don't contain the exact quote/turn you need.

Search workflow:
- Time-based ("last week", "today", "since X"): cat ~/.deeplake/memory/index.md and read the most-recent rows.
- Keyword/topic recall: grep -r "keyword" ~/.deeplake/memory/summaries/ (the shell hook routes this through hybrid lexical+semantic search — synonyms match too). Then cat the top-matching summary.
- Raw transcript fallback only: grep -r "keyword" ~/.deeplake/memory/sessions/ (use sparingly — JSONL is verbose).

✅ grep -r "keyword" ~/.deeplake/memory/summaries/
❌ grep without a summaries/ or sessions/ suffix — too noisy

IMPORTANT: Only use bash builtins (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) on ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.

SKILLS (skilify) — mine + share reusable skills across the org:
- node "HIVEMIND_CLI" skilify                         — show scope/team/install + per-project state
- node "HIVEMIND_CLI" skilify pull                    — sync project skills from the org table
- node "HIVEMIND_CLI" skilify pull --user <email>     — only that author's skills
- node "HIVEMIND_CLI" skilify pull --users a,b,c      — multiple authors (CSV)
- node "HIVEMIND_CLI" skilify pull --all-users        — explicit "no author filter"
- node "HIVEMIND_CLI" skilify pull --to project|global  — install location
- node "HIVEMIND_CLI" skilify pull --dry-run          — preview only
- node "HIVEMIND_CLI" skilify pull --force            — overwrite local (creates .bak)
- node "HIVEMIND_CLI" skilify pull <skill-name>       — pull only that skill (combines with --user)
- node "HIVEMIND_CLI" skilify scope <me|team|org>     — sharing scope for new skills
- node "HIVEMIND_CLI" skilify install <project|global>  — default install location
- node "HIVEMIND_CLI" skilify team add|remove|list <name>  — manage team list`;

interface CodexSessionStartInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  source?: string;
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  const input = await readStdin<CodexSessionStartInput>();

  const creds = loadCredentials();

  if (!creds?.token) {
    log("no credentials found — run auth login to authenticate");
  } else {
    log(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  }

  // Spawn async setup (table creation, placeholder, version check) as detached process.
  // Codex doesn't support async hooks, so we use the same pattern as the wiki worker.
  if (creds?.token) {
    const setupScript = join(__bundleDir, "session-start-setup.js");
    const child = spawn("node", [setupScript], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env },
    });
    // Feed the same stdin input to the setup process
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.unref();
    log("spawned async setup process");
  }

  let versionNotice = "";
  const current = getInstalledVersion(__bundleDir, ".codex-plugin");
  if (current) {
    versionNotice = `\nHivemind v${current}`;
  }

  const resolvedContext = context.replace(/HIVEMIND_CLI/g, HIVEMIND_CLI);
  const additionalContext = creds?.token
    ? `${resolvedContext}\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${versionNotice}`
    : `${resolvedContext}\nNot logged in to Deeplake. Run: node "${AUTH_CMD}" login${versionNotice}`;

  // Codex SessionStart: plain text on stdout is added as developer context.
  // JSON { additionalContext } format is rejected by Codex 0.118.0.
  console.log(additionalContext);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
