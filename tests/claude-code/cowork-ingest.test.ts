import { describe, it, expect } from "vitest";
import { entryForLine, extractText, COWORK_AGENT } from "../../src/mcp/cowork-ingest.js";

describe("extractText", () => {
  it("returns a plain string unchanged", () => {
    expect(extractText("hello world")).toBe("hello world");
  });

  it("joins text blocks and ignores thinking/tool_use", () => {
    const content = [
      { type: "thinking", thinking: "hmm", signature: "x" },
      { type: "text", text: "first" },
      { type: "tool_use", name: "hivemind_search", input: {} },
      { type: "text", text: "second" },
    ];
    expect(extractText(content)).toBe("first\nsecond");
  });

  it("returns empty string for non-text content", () => {
    expect(extractText(undefined)).toBe("");
    expect(extractText([{ type: "thinking", thinking: "x" }])).toBe("");
  });
});

describe("entryForLine", () => {
  const base = {
    sessionId: "b27efa59-a8bc-4ea3-8b02-18cbc608ae17",
    timestamp: "2026-06-26T15:02:13.529Z",
    cwd: "/some/cowork/outputs",
  };

  it("maps a user line to a user_message entry tagged as Cowork", () => {
    const entry = entryForLine({ ...base, type: "user", message: { content: "ciao" } });
    expect(entry).toMatchObject({
      session_id: base.sessionId,
      timestamp: base.timestamp,
      type: "user_message",
      content: "ciao",
      agent: COWORK_AGENT,
    });
  });

  it("maps an assistant line with text blocks to an assistant_message entry", () => {
    const entry = entryForLine({
      ...base,
      type: "assistant",
      message: { content: [{ type: "text", text: "risposta" }] },
    });
    expect(entry).toMatchObject({ type: "assistant_message", content: "risposta", agent: COWORK_AGENT });
  });

  it("skips assistant turns that carry no text (pure thinking / tool_use)", () => {
    const entry = entryForLine({
      ...base,
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "x" }] },
    });
    expect(entry).toBeNull();
  });

  it("skips empty user messages and non-message line types", () => {
    expect(entryForLine({ ...base, type: "user", message: { content: "   " } })).toBeNull();
    expect(entryForLine({ ...base, type: "queue-operation" })).toBeNull();
    expect(entryForLine({ ...base, type: "attachment" })).toBeNull();
  });

  it("skips lines without a sessionId", () => {
    expect(entryForLine({ type: "user", message: { content: "hi" } })).toBeNull();
  });
});
