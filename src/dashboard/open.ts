/**
 * Cross-platform "open this file in the default application" helper.
 *
 * Used by `hivemind dashboard` to launch the generated HTML in the
 * user's browser. Best-effort by design — when we can't open it (no
 * GUI, unknown OS, missing helper binary), the dashboard command
 * still wrote the file to disk and surfaced the path on stdout, so
 * the user can open it manually.
 *
 * The pure functions (`resolveOpenPlatform`, `openCommandFor`) are
 * exported so tests can assert the platform mapping without
 * monkey-patching child_process.
 */

import { spawn } from "node:child_process";
import { platform as nodePlatform } from "node:os";

export type OpenPlatform = "linux" | "darwin" | "win32";

/** Map node's platform string to the subset we know how to open on.
 *  Returns null for platforms (aix, freebsd, sunos, ...) where the
 *  helper conventions vary too much to guess. */
export function resolveOpenPlatform(): OpenPlatform | null {
  const p = nodePlatform();
  if (p === "linux" || p === "darwin" || p === "win32") return p;
  return null;
}

export interface OpenCommand {
  command: string;
  args: string[];
}

/** Per-platform invocation. Pure — easy to test the matrix without
 *  spawning anything. Windows uses `cmd /c start "" <path>`; the
 *  empty `""` is the window title argument that `start` requires
 *  when its first quoted arg is a path. Without it, `start "C:\..."`
 *  treats the path AS a window title and opens a new shell. */
export function openCommandFor(p: OpenPlatform, path: string): OpenCommand {
  switch (p) {
    case "linux":
      return { command: "xdg-open", args: [path] };
    case "darwin":
      return { command: "open", args: [path] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", path] };
  }
}

export interface OpenResult {
  /** Did we try to spawn a helper? false on unknown OS. */
  attempted: boolean;
  /** Which helper we spawned, when attempted. */
  command?: string;
}

export interface OpenInBrowserOptions {
  /** Override platform detection. Tests only — production callers
   *  let `resolveOpenPlatform()` decide. */
  platformOverride?: OpenPlatform | null;
  /** Injected spawner. Tests substitute this to avoid touching the
   *  real child_process. Default: node:child_process spawn. */
  spawner?: typeof spawn;
}

/**
 * Spawn the platform's "open <path>" helper, detached so the parent
 * CLI exits immediately. Errors are swallowed:
 *   - spawn throws (ENOENT, etc.) → return attempted=false
 *   - spawn succeeds then child errors (helper missing) → ignored
 *     via the on('error') handler — we already returned.
 *
 * The detached + unref pattern lets the helper survive the parent
 * exit on POSIX. Windows doesn't need unref but it's harmless.
 */
export function openInBrowser(
  path: string,
  opts: OpenInBrowserOptions = {},
): OpenResult {
  const p = opts.platformOverride === undefined
    ? resolveOpenPlatform()
    : opts.platformOverride;
  if (!p) return { attempted: false };

  const { command, args } = openCommandFor(p, path);
  const useSpawn = opts.spawner ?? spawn;
  try {
    const child = useSpawn(command, args, { stdio: "ignore", detached: true });
    // The child errors AFTER spawn() returns (e.g. helper not on PATH).
    // We don't want that to crash the parent; swallowing here is the
    // contract: "best-effort, user already has the path on stdout".
    child.on("error", () => { /* best-effort */ });
    if (typeof (child as { unref?: () => void }).unref === "function") {
      child.unref();
    }
    return { attempted: true, command };
  } catch {
    return { attempted: false };
  }
}
