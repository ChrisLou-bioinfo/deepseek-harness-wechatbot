import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Tests the parts of the Feishu adapter that can be isolated without a live
// Lark connection: config validation, per-account state persistence, and
// SDK importability. The WS/long-connection behavior is covered by the SDK
// itself (integration verified by running with real creds).

describe("feishu adapter (isolated)", () => {
  beforeEach(() => { vi.resetModules(); });

  it("SDK is importable and exposes createLarkChannel", async () => {
    const sdk = await import("@larksuiteoapi/node-sdk");
    expect(typeof sdk.createLarkChannel).toBe("function");
    expect(typeof sdk.Client).toBe("function");
  });

  it("adapter requires appId+appSecret at start", async () => {
    const { feishuAdapter } = await import("../src/adapters/feishu/adapter.js");
    const ctx = { logger: { info: () => {}, error: () => {}, warn: () => {} } };
    await expect(
      feishuAdapter.start(ctx, { onMessage: () => {} }, { name: "x", appId: "", appSecret: "" }),
    ).rejects.toThrow(/appId/);
  });

  it("persists credentials to state on start", async () => {
    const { feishuAdapter } = await import("../src/adapters/feishu/adapter.js");
    const store = await import("../src/adapters/state-store.js");
    const ctx = { logger: { info: () => {}, error: () => {}, warn: () => {} } };
    vi.spyOn(feishuAdapter, "start"); // no-op, just to keep shape
    // Actually call start with valid config; connect() will fail at network level
    // but must NOT throw (we .catch it); returns close().
    const disposer = await feishuAdapter.start(
      ctx,
      { onMessage: () => {} },
      { name: "acc1", appId: "cli_test", appSecret: "sec_test" },
    );
    expect(typeof disposer.close).toBe("function");
    const saved = store.loadState("feishu", "acc1");
    expect(saved.appId).toBe("cli_test");
    expect(saved.appSecret).toBe("sec_test");
    disposer.close();
  });

  it("send builds a text message via client.im.v1.message.create with receive_id_type=chat_id", async () => {
    // Mock the Client class so we never touch the network.
    const createdBody = { captured: null };
    class FakeClient {
      constructor() {}
      im = {
        v1: {
          message: {
            create: async (opts) => {
              createdBody.captured = opts;
              return { code: 0 };
            },
          },
        },
      };
    }
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      createLarkChannel: () => ({ on: () => {}, connect: async () => {}, disconnect: () => {} }),
      Client: FakeClient,
      LoggerLevel: { info: "info" },
    }));
    const { feishuAdapter } = await import("../src/adapters/feishu/adapter.js");
    await feishuAdapter.start(
      { logger: { info: () => {}, warn: () => {}, error: () => {} } },
      { onMessage: () => {} },
      { name: "acc2", appId: "a", appSecret: "s" },
    );
    await feishuAdapter.send({}, { platform: "feishu", account: "acc2", conversationKey: "oc_123" }, "你好");
    expect(createdBody.captured.params.receive_id_type).toBe("chat_id");
    expect(createdBody.captured.data.receive_id).toBe("oc_123");
    expect(createdBody.captured.data.msg_type).toBe("text");
    expect(JSON.parse(createdBody.captured.data.content)).toEqual({ text: "你好" });
  });
});
