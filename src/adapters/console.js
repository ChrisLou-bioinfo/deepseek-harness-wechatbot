/**
 * Console adapter — zero-dependency demo of the IM bridge.
 * Reads lines on stdin, prints replies with a `[reply]` prefix.
 *
 * Adapter contract (implemented by every adapter):
 *   start(ctx, { onMessage }) → disposer      (must not throw; log instead)
 *   send(ctx, msg, text) → Promise<void>      (deliver a reply to the originating conversation)
 *
 * `msg` is normalized: { platform, account, conversationKey, text, sender }.
 *
 * Note: inside a DSH profile the process may consume piped stdin before this
 * adapter mounts, so relying solely on readline's 'line' can miss input. We use
 * readline when stdin is a TTY and a raw buffer-splitting fallback otherwise.
 */
export const consoleAdapter = {
  id: "console",
  label: "Console (stdin/stdout)",
  async start(ctx, { onMessage }, _platformConfig = {}) {
    const emitLine = (text) => {
      const clean = String(text ?? "").trim();
      if (!clean) return;
      onMessage({ platform: "console", account: "stdin", conversationKey: "default", text: clean, sender: "stdin" });
    };

    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        emitLine(line);
      }
    };
    process.stdin.on("data", onData);
    const onEnd = () => process.stdout.write("imchat: console input closed\n");
    process.stdin.on("end", onEnd);
    if (process.stdin.isPaused()) process.stdin.resume();

    ctx.logger.info("imchat: console adapter started — type a message and press Enter");
    return {
      close() {
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
      },
    };
  },
  async send(ctx, msg, text) {
    const prefix = `[reply ${msg.platform}/${msg.account}/${msg.conversationKey}]`;
    process.stdout.write(`${prefix} ${text}\n`);
  },
};
