/**
 * Tests for the cross-platform open helper. The pure mappings get
 * exhaustive coverage; the spawn-wrapping `openInBrowser` is tested
 * via an injected stub so no real child process starts during tests.
 */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import {
  openCommandFor,
  openInBrowser,
  resolveOpenPlatform,
} from "../../src/dashboard/open.js";

function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & { unref: () => void };
  ee.unref = vi.fn();
  return ee;
}

describe("openCommandFor", () => {
  it("uses xdg-open on linux", () => {
    expect(openCommandFor("linux", "/x/y.html"))
      .toEqual({ command: "xdg-open", args: ["/x/y.html"] });
  });
  it("uses open on darwin", () => {
    expect(openCommandFor("darwin", "/x/y.html"))
      .toEqual({ command: "open", args: ["/x/y.html"] });
  });
  it("uses 'cmd /c start \"\" <path>' on win32 to dodge the title-arg trap", () => {
    expect(openCommandFor("win32", "C:\\x\\y.html"))
      .toEqual({ command: "cmd", args: ["/c", "start", "", "C:\\x\\y.html"] });
  });
});

describe("resolveOpenPlatform", () => {
  it("returns one of the known platforms when called on this host", () => {
    const got = resolveOpenPlatform();
    expect(got === null || got === "linux" || got === "darwin" || got === "win32").toBe(true);
  });
});

describe("openInBrowser", () => {
  it("returns attempted=false when platformOverride is null (unknown OS)", () => {
    const spawner = vi.fn();
    const result = openInBrowser("/whatever", { platformOverride: null, spawner: spawner as any });
    expect(result.attempted).toBe(false);
    expect(spawner).not.toHaveBeenCalled();
  });

  it("spawns the linux helper and reports the command name", () => {
    const child = fakeChild();
    const spawner = vi.fn().mockReturnValue(child);
    const result = openInBrowser("/tmp/dash.html", {
      platformOverride: "linux",
      spawner: spawner as any,
    });
    expect(result.attempted).toBe(true);
    expect(result.command).toBe("xdg-open");
    expect(spawner).toHaveBeenCalledWith(
      "xdg-open",
      ["/tmp/dash.html"],
      expect.objectContaining({ stdio: "ignore", detached: true }),
    );
    expect(child.unref).toHaveBeenCalled();
  });

  it("returns attempted=false when spawner throws (helper not installed)", () => {
    const spawner = vi.fn(() => { throw new Error("ENOENT xdg-open"); });
    const result = openInBrowser("/tmp/dash.html", {
      platformOverride: "linux",
      spawner: spawner as any,
    });
    expect(result.attempted).toBe(false);
    expect(result.command).toBeUndefined();
  });

  it("swallows post-spawn 'error' events so a missing helper doesn't crash the CLI", () => {
    const child = fakeChild();
    const spawner = vi.fn().mockReturnValue(child);
    openInBrowser("/tmp/dash.html", { platformOverride: "darwin", spawner: spawner as any });
    // Fire the error AFTER the call returned — the handler attached
    // inside openInBrowser should absorb it without re-throwing.
    expect(() => child.emit("error", new Error("helper crashed"))).not.toThrow();
  });

  it("works even when the returned child lacks unref (older platforms)", () => {
    const ee = new EventEmitter() as EventEmitter & { unref?: () => void };
    const spawner = vi.fn().mockReturnValue(ee);
    expect(() => openInBrowser("/tmp/dash.html", {
      platformOverride: "linux",
      spawner: spawner as any,
    })).not.toThrow();
  });
});
