import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { login, syncOnce, sendText, sendTyping } from "../src/adapters/matrix/protocol.js";

function mockFetch(handler) {
  const fn = vi.fn(async (url, init) => {
    const result = await handler(String(url), init);
    return result instanceof Response
      ? result
      : {
          ok: (result.status ?? 200) < 400,
          status: result.status ?? 200,
          json: async () => result.json ?? {},
          text: async () => (typeof result.text === "string" ? result.text : JSON.stringify(result.json ?? {})),
        };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const HS = "https://matrix.example.org";

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("matrix protocol", () => {
  it("login sends m.login.password with m.id.user identifier", async () => {
    const fn = mockFetch((url, init) => {
      expect(String(url)).toContain("/_matrix/client/v3/login");
      const body = JSON.parse(init.body);
      expect(body.type).toBe("m.login.password");
      expect(body.identifier).toEqual({ type: "m.id.user", user: "alice" });
      expect(body.password).toBe("secret");
      return { status: 200, json: { access_token: "at", user_id: "alice" } };
    });
    const res = await login({ homeserver: HS, userId: "alice", password: "secret" });
    expect(res.access_token).toBe("at");
  });

  it("syncOnce builds since+timeout+filter and parses join timeline", async () => {
    const fn = mockFetch((url) => {
      expect(String(url)).toContain("/sync?");
      expect(String(url)).toContain("since=abc");
      expect(String(url)).toContain("timeout=30000");
      expect(String(url)).toContain("filter=");
      return {
        status: 200,
        json: {
          next_batch: "nb2",
          rooms: { join: { "!room:hs": { timeline: { events: [{ event_id: "e1", sender: "@bob", type: "m.room.message", content: { msgtype: "m.text", body: "hello" }, roomId: "!room:hs" }] } } } },
        },
      };
    });
    const res = await syncOnce({ homeserver: HS, token: "tk", since: "abc", timeoutMs: 30000 });
    expect(res.nextBatch).toBe("nb2");
    expect(res.events).toHaveLength(1);
    expect(res.events[0].roomId).toBe("!room:hs");
    expect(fn.mock.calls[0][1].headers.Authorization).toBe("Bearer tk");
  });

  it("sendText PUTs correct URL path with txnId and m.text body", async () => {
    const fn = mockFetch((url, init) => {
      expect(String(url)).toBe(`${HS}/_matrix/client/v3/rooms/!r%3A0/send/m.room.message/txn-9`);
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({ msgtype: "m.text", body: "hi!" });
      expect(init.headers.Authorization).toBe("Bearer tk");
      return { status: 200, json: { event_id: "e99" } };
    });
    await sendText({ homeserver: HS, token: "tk", roomId: "!r:0", txnId: "txn-9", text: "hi!" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("sendTyping PUTs typing endpoint", async () => {
    const fn = mockFetch((url, init) => {
      expect(String(url)).toContain("/typing/%40alice");
      expect(JSON.parse(init.body).typing).toBe(true);
      return { status: 200, json: {} };
    });
    await sendTyping({ homeserver: HS, token: "tk", roomId: "!r", userId: "@alice", typing: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("sync propagates auth error flag", async () => {
    mockFetch(() => ({ status: 401, json: {} }));
    await expect(syncOnce({ homeserver: HS, token: "bad", since: undefined })).rejects.toMatchObject({ auth: true });
  });
});
