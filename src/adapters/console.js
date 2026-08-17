import { createInterface } from "node:readline/promises";

/**
 * Console adapter — zero-dependency demo of the IM bridge.
 * Reads lines on stdin, prints replies with a `[reply]` prefix.
 *
 * Adapter contract (implemented by every adapter):
 *   start(ctx, { onMessage }) → disposer      (must not throw; log instead)
 *   send(ctx, msg, text) → Promise<void>      (deliver a reply to the originating conversation)
 *
 * `msg` is normalized: { platform, account, conversationKey, text, sender }.
 */
export const consoleAdapter = {
  id: "console",
  label: "Console (stdin/stdout)",
  async start(ctx, { onMessage }, _platformConfig = {}) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      onMessage({
        platform: "console",
        account: "stdin",
        conversationKey: "default",
        text,
        sender: "stdin",
      });
    });
    rl.on("close", () => process.stdout.write("imchat: console input closed\n"));
    ctx.logger.info("imchat: console adapter started — type a message and press Enter");
    return rl; // readline Interface exposes .close()
  },
  async send(ctx, msg, text) {
    const prefix = `[reply ${msg.platform}/${msg.account}/${msg.conversationKey}]`;
    process.stdout.write(`${prefix} ${text}\n`);
  },
};
