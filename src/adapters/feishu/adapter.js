import { createLarkChannel, Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { loadState, saveState } from "../state-store.js";

/**
 * Feishu (飞书/Lark) adapter — official Node SDK, long-connection mode.
 *
 * Uses the SDK's high-level Channel module (createLarkChannel) which bundles
 * the WS long connection, event normalization, and message sending.
 *
 * Adapter contract:
 *   start(ctx, { onMessage }) → disposer  (never throws; captures config)
 *   send(ctx, msg, replyText) → Promise    (uses credentials captured at start)
 * conversationKey = chatId. Ignores app/self messages and non-text.
 *
 * Because the bridge designs adapters as stateless start + send with the same
 * `msg` (which carries platform/account/conversationKey), we capture a
 * per-account send client in our own registry keyed by account name.
 */

// Per-account runtime state: { client, channel } — survives across bridge calls.
const accounts = new Map();

const feishuAdapter = {
  id: "feishu",
  label: "Feishu (Lark official SDK, long connection)",
  async start(ctx, { onMessage }, accountConfig = {}) {
    const config = { name: "default", ...accountConfig };
    if (!config.appId || !config.appSecret) {
      throw new Error(`feishu: account "${config.name}" needs appId + appSecret`);
    }
    const log = (m) => process.stderr.write(`[feishu:${config.name}] ${m}\n`);
    const baseConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: LoggerLevel.info,
    };

    // Persist so send() can re-derive a client after restart.
    saveState("feishu", config.name, { appId: config.appId, appSecret: config.appSecret, savedAt: new Date().toISOString() });

    const channel = createLarkChannel(baseConfig);
    accounts.set(config.name, { client: new Client(baseConfig), channel });

    channel.on("message", async (msg) => {
      try {
        onMessage({
          platform: "feishu",
          account: config.name,
          conversationKey: msg.chatId,
          text: String(msg.content ?? "").trim(),
          sender: msg.senderId ?? "",
        });
      } catch (err) {
        log(`handle message failed: ${String(err)}`);
      }
    });

    // Establish + keep the WS long connection (SDK reconnects internally).
    channel.connect().catch((err) => log(`connect failed: ${String(err)}`));

    return {
      close() {
        try {
          channel.disconnect?.();
        } catch {}
        accounts.delete(config.name);
      },
    };
  },

  async send(ctx, msg, replyText) {
    const account = msg.account;
    let entry = accounts.get(account);
    if (!entry) {
      // Recovered from disk after a restart raced with start() — build on demand.
      const st = loadState("feishu", account);
      if (!st.appId || !st.appSecret) throw new Error(`feishu: no credentials for "${account}"`);
      entry = { client: new Client({ appId: st.appId, appSecret: st.appSecret }) };
      accounts.set(account, entry);
    }
    await entry.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: msg.conversationKey,
        msg_type: "text",
        content: JSON.stringify({ text: replyText }),
      },
    });
  },
};

export { feishuAdapter };
