import z from "@deepseek-ai/schemastery";
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
import { createBridge } from "./lib/bridge.js";
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
  const bridge = await createBridge(ctx, { randomIds: true });
  const replies = [];
  await bridge.handle(
    { platform: "console", account: "self", conversationKey: "self", text, sender: "self" },
    async (reply) => replies.push(reply),
  );
  process.stdout.write((replies[0] ?? "(no reply)") + "\n");
  await bridge.stop();
}

async function startLongRunning(ctx, config) {
  const bridge = await createBridge(ctx);
  const enabled = config.adapters ?? ["console"];
  const platforms = config.platforms ?? {};
  const disposers = [];

  // Keep the event loop alive: a DSH profile with no server and no active
  // task would otherwise exit as soon as stdin/sockets idle. A low-frequency
  // timer holds the process up without doing work.
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
  keepAlive.unref?.();

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
      if (disposer?.close) disposers.push(disposer);
    } catch (err) {
      process.stderr.write(`imchat: adapter "${id}" failed to start: ${String(err)}\n`);
    }
  }
  ctx.effect(() => {
    clearInterval(keepAlive);
    for (const d of disposers) try { d.close(); } catch {}
    bridge.stop().catch(() => {});
  });
}

/** Cordis plugin entry; sync apply, heavy work fired async. */
function apply(ctx, config) {
  const program = new Command()
    .name("dsh --profile imchat")
    .helpOption(false)
    .argument("[text...]", "self-test prompt text")
    .option("--self-test", "run one message through the bridge, print the reply, and exit")
    .action(() => {
      const text = program.args.join(" ");
      if (program.getOptionValue("selfTest")) {
        runSelfTest(ctx, config, text || "Reply with exactly: IM-BRIDGE-OK").then(
          () => ctx.get("appExit")?.(0),
          (err) => {
            process.stderr.write(`imchat: self-test failed: ${String(err)}\n`);
            ctx.get("appExit")?.(1);
          },
        );
        return;
      }
      startLongRunning(ctx, config).catch((err) => {
        process.stderr.write(`imchat: startup failed: ${String(err)}\n`);
      });
    });
  parseCmdline(ctx, program);
}

const Config = z.object({
  adapters: z.array(z.string()).default(["console"]),
  // schemastery objects allow unknown keys by default (no .passthrough needed)
  platforms: z.object({}),
});

/** Required core services; the loader validates and injects them. */
export const inject = ["agents", "sessions", "agentDefaultModel", "cmdlineArgs", "appExit"];

export { Config, apply, name };
