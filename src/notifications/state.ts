/**
 * Atomic dedup state at ~/.deeplake/notifications-state.json.
 *
 * Atomicity: write to *.tmp then rename. POSIX rename(2) is atomic, so two
 * parallel SessionStart drains racing on the same HOME can corrupt at most
 * the last writer's payload (whichever rename wins) — never produce a
 * partial/torn JSON file. Cross-instance race coverage in
 * notifications.test.ts.
 *
 * Sandbox guard (CLAUDE.md post-mortem rule #1): writes refuse to leave the
 * directory pointed at by HOME *as resolved at call time*. Tests that set
 * HOME=$(mktemp -d) before each case are isolated automatically; an
 * accidental absolute-path injection cannot reach the real ~/.deeplake/.
 */

import { closeSync, openSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { NotificationsState, Notification } from "./types.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("notifications-state", msg);

export function statePath(): string {
  return join(homedir(), ".deeplake", "notifications-state.json");
}

const EMPTY: NotificationsState = { shown: {} };

export function readState(): NotificationsState {
  try {
    const raw = readFileSync(statePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.shown !== "object") {
      log(`state malformed → treating as empty`);
      return { shown: {} };
    }
    return { shown: { ...parsed.shown } };
  } catch {
    return { shown: {} };
  }
}

export function writeState(state: NotificationsState): void {
  const path = statePath();
  const home = resolve(homedir());
  if (!resolve(path).startsWith(home + "/") && resolve(path) !== home) {
    // Sandbox guard — never write outside the user's HOME.
    throw new Error(`notifications-state write blocked: ${path} is outside ${home}`);
  }
  mkdirSync(join(home, ".deeplake"), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function markShown(state: NotificationsState, n: Notification, now: Date = new Date()): NotificationsState {
  return {
    shown: {
      ...state.shown,
      [n.id]: { dedupKey: JSON.stringify(n.dedupKey), shownAt: now.toISOString() },
    },
  };
}

export function alreadyShown(state: NotificationsState, n: Notification): boolean {
  const prev = state.shown[n.id];
  if (!prev) return false;
  return prev.dedupKey === JSON.stringify(n.dedupKey);
}

/**
 * Per-notification atomic claim — guards against concurrent SessionStart
 * hook invocations both emitting the same notification.
 *
 * Why this exists: the post-PR-#96 hook layout registers
 * `session-notifications.js` in BOTH `~/.claude/settings.json` (literal
 * path) AND the marketplace `hooks.json` (`${CLAUDE_PLUGIN_ROOT}` →
 * same path). Claude Code fires both, so two node processes race the
 * read-emit-write cycle and both emit. `alreadyShown` + atomic state
 * write protect file integrity but not exactly-once delivery.
 *
 * Mechanism: try to create `~/.deeplake/notifications-claims/<id>-<hash>`
 * atomically (`openSync(path, "wx")` — O_CREAT|O_EXCL semantics). First
 * process wins; the racer gets `EEXIST` and skips the emission.
 *
 * Returns `true` if THIS process owns the claim and should emit, `false`
 * if another process already claimed it (and this process should skip).
 *
 * Claim files are inert — they don't carry payload. They expire by mtime
 * during the GC pass below (idempotently called from drainSessionStart).
 */
export function tryClaim(n: Notification): boolean {
  const home = resolve(homedir());
  const claimsDir = join(home, ".deeplake", "notifications-claims");
  try {
    mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
  } catch (e: any) {
    log(`tryClaim mkdir failed: ${e?.message ?? String(e)}`);
    return true; // fail-open: better to risk a duplicate than to silence everything
  }
  // 12 hex chars of sha-256 over dedupKey JSON keeps the filename short
  // and collision-resistant for our cardinality (a few dozen per week).
  const keyHash = createHash("sha256").update(JSON.stringify(n.dedupKey)).digest("hex").slice(0, 12);
  const safeId = n.id.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  const claimPath = join(claimsDir, `${safeId}-${keyHash}`);
  try {
    const fd = openSync(claimPath, "wx", 0o600);
    closeSync(fd);
    return true;
  } catch (e: any) {
    if (e?.code === "EEXIST") return false;
    log(`tryClaim open failed: ${e?.message ?? String(e)}`);
    return true; // fail-open
  }
}
