import { describe, expect, it, vi } from "vitest";
import { createBridge } from "../src/lib/bridge.js";
import { sessionIdFor, lastAssistantText } from "../src/lib/bridge.js";

/** Minimal ctx mock shaped like the Cordis plugin context. */
function makeCtx({ withPersistence = true, resumeFails = false } = {}) {
  const agents = {
    create: vi.fn(async (opts) => ({ agent: makeAgent(opts), dispose: vi.fn(async () => {}) })),
    resume: vi.fn(async (opts) => {
      if (resumeFails) throw new Error("ENOENT: no persisted log");
      return { agent: makeAgent(opts), dispose: vi.fn(async () => {}) };
    }),
  };
  const sessionEvents = [];
  const makeAgent = (opts) => ({
    id: opts.sessionId,
    session: { events: sessionEvents, seq: sessionEvents.length },
    followup: vi.fn(function (msg) {
      sessionEvents.push({ seq: sessionEvents.length, type: "user/message", data: msg });
    }),
    whenIdle: vi.fn(async function () {
      sessionEvents.push({
        seq: sessionEvents.length,
        type: "assistant/message",
        data: { message: { content: [{ type: "text", text: "mock-reply ok" }] } },
      });
      sessionEvents.push({ seq: sessionEvents.length, type: "turn/end", data: { reason: { kind: "completed" } } });
    }),
  });
  return {
    get: (k) => {
      if (k === "agents") return agents;
      if (k === "agentDefaultModel") return { currentSelection: () => ({ provider: "test", model: "test-model" }) };
      if (k === "sessions") return {};
      if (k === "sessionPersistence") return withPersistence ? { present: true } : undefined;
      return undefined;
    },
    agents,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
}

describe("bridge core", () => {
  it("sessionIdFor is deterministic and key-unique", () => {
    const a = sessionIdFor("room-1");
    const b = sessionIdFor("room-1");
    const c = sessionIdFor("room-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(String(a)).toMatch(/^session-/);
  });

  it("messages for the same key route to one agent (session isolation)", async () => {
    const ctx = makeCtx({ withPersistence: false });
    const bridge = await createBridge(ctx, { randomIds: false });
    const replies = [];
    await bridge.handle({ platform: "m", account: "a", conversationKey: "k1", text: "hi", sender: "s1" }, async (r) => replies.push(r));
    await bridge.handle({ platform: "m", account: "a", conversationKey: "k2", text: "yo", sender: "s1" }, async (r) => replies.push(r));
    // two distinct conversations → two distinct agents even without persistence
    expect(ctx.agents.create).toHaveBeenCalledTimes(2);
    expect(ctx.agents.create.mock.calls[0][0].sessionId).not.toBe(ctx.agents.create.mock.calls[1][0].sessionId);
    expect(replies).toEqual(["mock-reply ok", "mock-reply ok"]);
    await bridge.stop();
  });

  it("resumes when persistence present, creates when absent", async () => {
    const withP = makeCtx({ withPersistence: true });
    const b1 = await createBridge(withP, { randomIds: false });
    await b1.handle({ platform: "m", account: "a", conversationKey: "k", text: "hi", sender: "s" }, async () => {});
    expect(withP.agents.resume).toHaveBeenCalled();
    await b1.stop();

    const withoutP = makeCtx({ withPersistence: false });
    const b2 = await createBridge(withoutP, { randomIds: false });
    await b2.handle({ platform: "m", account: "a", conversationKey: "k", text: "hi", sender: "s" }, async () => {});
    expect(withoutP.agents.resume).not.toHaveBeenCalled();
    expect(withoutP.agents.create).toHaveBeenCalled();
    await b2.stop();
  });

  it("falls back to create when resume fails with no-log error", async () => {
    const ctx = makeCtx({ withPersistence: true, resumeFails: true });
    const bridge = await createBridge(ctx, { randomIds: false });
    await bridge.handle({ platform: "m", account: "a", conversationKey: "k", text: "hi", sender: "s" }, async () => {});
    expect(ctx.agents.resume).toHaveBeenCalled();
    expect(ctx.agents.create).toHaveBeenCalled();
    await bridge.stop();
  });

  it("lastAssistantText finds the newest assistant text", () => {
    const session = {
      events: [
        { type: "user/message", data: { content: [{ type: "text", text: "u" }] } },
        { type: "assistant/message", data: { message: { content: [{ type: "text", text: "first" }] } } },
        { type: "assistant/message", data: { message: { content: [{ type: "text", text: "latest" }] } } },
        { type: "turn/end", data: {} },
      ],
    };
    expect(lastAssistantText(session)).toBe("latest");
  });
});
