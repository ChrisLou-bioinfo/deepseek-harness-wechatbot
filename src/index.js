import z from "@deepseek-ai/schemastery";
import path from "node:path";
import { createBridge } from "./lib/bridge.js";
import { startQRServer } from "./lib/qr-server.js";
import { consoleAdapter } from "./adapters/console.js";
import { wechatAdapter } from "./adapters/wechat/adapter.js";
import { matrixAdapter } from "./adapters/matrix/adapter.js";
import { feishuAdapter } from "./adapters/feishu/adapter.js";

/**
 * @module @chris/imchat
 *
 * IM chat bridge for DeepSeek Harness. Long-lived profile plugin that routes
 * inbound IM messages (Matrix / Feishu / WeChat) to an owned per-conversation
 * DSH agent, then sends the model's reply back to the originating conversation.
 *
 * App surface (owned via dsh-cmdline):
 *   dsh --profile imchat                          run the always-on bridge
 *   dsh --profile imchat --self-test [text]       one-shot bridge test: reply → stdout → exit
 *
 * v0.1 — clean structure: bridge core in src/lib/bridge.js, adapters in
 * src/adapters/, this file is CLI glue only.
 */

/** Stable Cordis plugin name. */
const name = "imchat";

/** Re-register all implemented adapters. */
const adapters = new Map(
  [consoleAdapter, wechatAdapter, matrixAdapter, feishuAdapter]
    .filter((a) => a && typeof a.start === "function")
    .map((a) => [a.id, a]),
);

async function runSelfTest(ctx, config, text) {
  // randomIds true → no persistence interference; set IMCHAT_DETERMINISTIC to
  // exercise the resume path against any existing persisted log for the key.
  const bridge = await createBridge(ctx, { randomIds: !process.env.IMCHAT_DETERMINISTIC });
  const replies = [];
  await bridge.handle(
    { platform: "console", account: "self", conversationKey: "self", text, sender: "self" },
    async (reply) => replies.push(reply),
  );
  process.stdout.write((replies[0] ?? "(no reply)") + "\n");
  await bridge.stop();
}

async function startLongRunning(ctx, config, keepAlive) {
  // Fixed workspace for the whole bridge (default: ./.imchat-workspace under cwd).
  const workspaceRoot = config.workspaceDir ?? path.resolve(process.cwd(), ".imchat-workspace");
  process.stderr.write(`imchat: bridge workspace = ${workspaceRoot}\n`);
  const bridge = await createBridge(ctx, { workspaceRoot });
  const enabled = config.adapters ?? ["console"];
  const platforms = config.platforms ?? {};
  const disposers = [];

  // QR viewer: exposed at http://127.0.0.1:<port>/qr (browser-scannable login).
  try {
    const qr = await startQRServer();
    process.stderr.write(`imchat: QR viewer at http://127.0.0.1:${qr.port}/qr\n`);
  } catch (err) {
    process.stderr.write(`imchat: QR server not started (${String(err)})\n`);
  }

  process.stderr.write(`imchat: starting ${enabled.length} adapter(s)\n`);

  for (const id of enabled) {
    const adapter = adapters.get(id);
    if (!adapter) {
      ctx.logger.warn(`imchat: unknown adapter "${id}" ignored`);
      continue;
    }
    // Per-adapter credentials/config (appId, appSecret, homeserver, accounts, ...)
    // come from config.platforms[<id>]. Some adapters create multiple accounts;
    // pass the raw config through.
    const platformConfig = { name: id, ...(platforms[id] ?? {}) };
    const base = { onMessage: (msg) => {
      bridge.handle(msg, (reply) => adapter.send(ctx, msg, reply)).catch((err) =>
        process.stderr.write(`imchat: ${String(err)}\n`),
      );
    } };
    try {
      const disposer = await adapter.start(ctx, base, platformConfig);
      process.stderr.write(`imchat: adapter "${id}" started\n`);
      if (disposer?.close) disposers.push(disposer);
    } catch (err) {
      process.stderr.write(`imchat: adapter "${id}" failed to start: ${String(err)}\n`);
    }
  }
  // Return the cleanup for the apply (durable) fiber to register — registering
  // it here would run in whatever async context called us (commander/action)
  // and get disposed immediately, which is exactly the bug we're fixing.
  return async function shutdown() {
    clearInterval(keepAlive);
    for (const d of disposers) try { (await d.close?.()) ?? d.close?.(); } catch {}
    await bridge.stop().catch(() => {});
  };
}

/** Cordis plugin entry. Runs in the DSH durable fiber (NOT commander's action
 *  context), so ctx.effect registrations here live for the process lifetime. */
function apply(ctx, config) {
  const cmd = ctx.get("cmdlineArgs");
  const args = cmd?.get() ?? [];
  const selfTestIdx = args.indexOf("--self-test");

  if (selfTestIdx >= 0) {
    // One-shot self-test mode: bridge → model → print reply → exit.
    const raw = args.slice(selfTestIdx + 1).join(" ").trim();
    const text = raw || "Reply with exactly: IM-BRIDGE-OK";
    runSelfTest(ctx, config, text).then(
      () => ctx.get("appExit")?.(0),
      (err) => {
        process.stderr.write(`imchat: self-test failed: ${String(err)}\n`);
        ctx.get("appExit")?.(1);
      },
    );
    return;
  }

  // Long-running bridge mode. Register the keep-alive timer synchronously so
  // the process cannot exit between here and adapter sockets opening. The
  // timer is NOT unref'd (that would defeat it); we clear it on shutdown.
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
  ctx.effect(() => clearInterval(keepAlive)); // runs on real shutdown (durable fiber)
  process.stderr.write("imchat: long-running mode starting\n");
  // startLongRunning registers no ctx.effect itself; the cleanup it returns is
  // bound here, in the durable fiber, so adapters are only closed on real
  // shutdown and never aborted immediately after startup.
  startLongRunning(ctx, config, keepAlive).then(
    (shutdown) => ctx.effect(() => { shutdown().catch(() => {}); }),
    (err) => process.stderr.write(`imchat: startup failed: ${String(err)}\n`),
  );
}

const Config = z.object({
  adapters: z.array(z.string()).default(["console"]),
  // Fixed bridge workspace (absolute or relative path); defaults to
  // <cwd>/.imchat-workspace. All platform conversations share this area.
  workspaceDir: z.string(),
  // schemastery objects allow unknown keys by default (no .passthrough needed)
  platforms: z.object({}),
});

/** Required core services; the loader validates and injects them. */
export const inject = ["agents", "sessions", "agentDefaultModel", "cmdlineArgs", "appExit"];

export { Config, apply, name };
