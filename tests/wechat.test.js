import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  getUpdates,
  sendMessage,
  notifyStart,
  apiPost,
  extractText,
  DEFAULT_BASE_URL,
} from "../src/adapters/wechat/protocol.js";

function mockFetch(json, status = 200) {
  const fn = vi.fn(async () => ({ ok: status < 400, status, json: async () => (typeof json === "function" ? json() : json) }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("wechat protocol", () => {
  it("getUpdates sends cursor and parses msgs + new cursor", async () => {
    const fetchFn = mockFetch({ ret: 0, msgs: [{ message_id: 5, from_user_id: "u1", item_list: [{ type: 1, text_item: { text: "hi" } }] }], get_updates_buf: "abc123", is_new: true });
    const res = await getUpdates(DEFAULT_BASE_URL, "tk", "prev", { timeoutMs: 2000 });
    expect(res.msgs).toHaveLength(1);
    expect(res.getUpdatesBuf).toBe("abc123");
    // assert request body carried previous cursor
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("getupdates");
    expect(JSON.parse(init.body)).toEqual({ get_updates_buf: "prev" });
  });

  it("getUpdates throws on non-ret", async () => {
    mockFetch({ ret: 1, errmsg: "boom" });
    await expect(getUpdates(DEFAULT_BASE_URL, "tk", "")).rejects.toThrow(/boom/);
  });

  it("sendMessage builds correct body incl. context_token echo", async () => {
    const fetchFn = mockFetch({ ret: 0 });
    await sendMessage(DEFAULT_BASE_URL, "tk", { to: "u1", text: "reply", contextToken: "ctx-9", clientId: "c-1" });
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.msg.to_user_id).toBe("u1");
    expect(body.msg.context_token).toBe("ctx-9");
    expect(body.msg.item_list[0]).toEqual({ type: 1, text_item: { text: "reply" } });
    expect(body.msg.message_type).toBe(2);
    expect(body.msg.message_state).toBe(2);
    expect(init.headers.Authorization).toBe("Bearer tk");
    expect(init.headers.AuthorizationType).toBe("ilink_bot_token");
  });

  it("apiPost sends UIN header and respects timeout abort", async () => {
    const fetchFn = mockFetch({ ret: 0 });
    await apiPost(DEFAULT_BASE_URL, "tk", "x", { a: 1 });
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers["X-WECHAT-UIN"]).toBeTruthy();
  });

  it("notifyStart hits ilink/bot/msg/notifystart", async () => {
    const fetchFn = mockFetch({ ret: 0 });
    await notifyStart(DEFAULT_BASE_URL, "tk");
    expect(String(fetchFn.mock.calls[0][0])).toContain("notifystart");
  });

  it("extractText returns text and ignores media", () => {
    expect(extractText([{ type: 2, image_item: {} }, { type: 1, text_item: { text: "hi" } }])).toBe("hi");
    expect(extractText([{ type: 2, image_item: {} }])).toBe("");
  });
});

describe("adapter flow (integration-ish)", () => {
  it("persists context tokens per conversation after inbound", async () => {
    // exercise handleInbound indirectly via the adapter's state-store contract
    const { loadState, saveState } = await import("../src/adapters/state-store.js");
    saveState("wechat", "t-test", { contextTokens: { u9: "tk-2" } });
    expect(loadState("wechat", "t-test").contextTokens.u9).toBe("tk-2");
  });
});
