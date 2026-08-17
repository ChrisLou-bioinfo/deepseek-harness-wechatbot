import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  getUpdates,
  sendMessage,
  notifyStart,
  apiPostFetch,
  extractText,
  DEFAULT_BASE_URL,
} from "../src/adapters/wechat/protocol.js";

function mockFetch(json, status = 200) {
  const fn = vi.fn(async () => ({ ok: status < 400, status, text: async () => JSON.stringify(typeof json === "function" ? json() : json), json: async () => (typeof json === "function" ? json() : json) }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("wechat protocol", () => {
  it("getUpdates hits ilink/bot/getupdates with cursor and base_info", async () => {
    const fetchFn = mockFetch({ ret: 0, msgs: [{ message_id: 5, from_user_id: "u1", item_list: [{ type: 1, text_item: { text: "hi" } }], context_token: "ctx-1" }], get_updates_buf: "abc123", is_new: true });
    const res = await getUpdates(DEFAULT_BASE_URL, "tk", "prev", { timeoutMs: 2000 });
    expect(res.msgs).toHaveLength(1);
    expect(res.getUpdatesBuf).toBe("abc123");
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("ilink/bot/getupdates");
    const body = JSON.parse(init.body);
    expect(body.get_updates_buf).toBe("prev");
    expect(body.base_info.channel_version).toBeTruthy();
    expect(init.headers["iLink-App-Id"]).toBe("bot");
    expect(init.headers["X-WECHAT-UIN"]).toBeTruthy();
  });

  it("getUpdates throws on protocol ret!=0 but surfaces ret for -14 handling", async () => {
    mockFetch({ ret: 1, errmsg: "boom" });
    await expect(getUpdates(DEFAULT_BASE_URL, "tk", "")).rejects.toThrow(/boom/);
  });

  it("getUpdates -14 ret surfaces as ret=-14 error for stale-token handling", async () => {
    mockFetch({ ret: 0, errcode: -14, errmsg: "session timeout" });
    // long-poll success with -14: caller inspects json
    const res = await getUpdates(DEFAULT_BASE_URL, "tk", "", { timeoutMs: 2000 });
    expect(res.json.errcode).toBe(-14);
  });

  it("sendMessage builds ilink/bot/sendmessage body with base_info + context_token", async () => {
    const fetchFn = mockFetch({ ret: 0 });
    await sendMessage(DEFAULT_BASE_URL, "tk", {
      msg: { to_user_id: "u1", client_id: "c-1", message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text: "reply" } }], context_token: "ctx-9" },
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("ilink/bot/sendmessage");
    const body = JSON.parse(init.body);
    expect(body.msg.to_user_id).toBe("u1");
    expect(body.msg.context_token).toBe("ctx-9");
    expect(body.msg.item_list[0]).toEqual({ type: 1, text_item: { text: "reply" } });
    expect(body.base_info.bot_agent).toBeTruthy();
    expect(init.headers.Authorization).toBe("Bearer tk");
  });

  it("notifyStart hits ilink/bot/msg/notifystart", async () => {
    const fetchFn = mockFetch({ ret: 0 });
    await notifyStart(DEFAULT_BASE_URL, "tk");
    expect(String(fetchFn.mock.calls[0][0])).toContain("ilink/bot/msg/notifystart");
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).base_info).toBeTruthy();
  });

  it("apiPostFetch maps stall to AbortError for normal long-poll control flow", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise((_, rej) => { setTimeout(() => rej(Object.assign(new Error("timed out"), { name: "AbortError" })), 5); })));
    // A real abort will surface as AbortError; getUpdates treats it as empty.
    const up = await getUpdates(DEFAULT_BASE_URL, "tk", "", { timeoutMs: 5 });
    expect(up.msgs).toEqual([]);
  });

  it("extractText returns text and ignores media", () => {
    expect(extractText([{ type: 2, image_item: {} }, { type: 1, text_item: { text: "hi" } }])).toBe("hi");
    expect(extractText([{ type: 2, image_item: {} }])).toBe("");
  });
});

describe("adapter flow (integration-ish)", () => {
  it("persists context tokens per conversation after inbound", async () => {
    const { loadState, saveState } = await import("../src/adapters/state-store.js");
    saveState("wechat", "t-test", { contextTokens: { u9: "tk-2" } });
    expect(loadState("wechat", "t-test").contextTokens.u9).toBe("tk-2");
  });
});
