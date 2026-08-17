import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import crypto from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
import { Command } from "commander";

/**
 * @module @chris/imchat
 *
 * IM bridge for DeepSeek Harness. A long-lived profile plugin that routes
 * inbound IM messages (Matrix / Feishu / WeChat) to an owned per-conversation
 * DSH agent driven directly through ctx.agents.create → followup → whenIdle,
 * then sends the model's reply back to the originating conversation.
 *
 * App surface (owned via dsh-cmdline):
 *   dsh --profile imchat                    run the always-on bridge (adapters)
 *   dsh --profile imchat --self-test <text> one-shot: bridge → model → print reply → exit
 *
 * v0 establishes the mechanism; adapter set is configurable (see cordis.patch.yml).
 */

/** Stable Cordis plugin name. */
const name = "imchat";

/** Build a UserMessage exactly like the headless runner does (native text source). */
function userMessage(text) {
  return createUserMessage({
    content: [{ type: "text", text: String(text) }],
    source: { kind: "user" },
  });
}

/** Deterministic session id from a conversation key (64-char-safe). */
function sessionIdFor(key, random = false) {
  if (random) {
    return SessionId(`session-${crypto.randomUUID()}`);
  }
  const digest = crypto.createHash("sha1").update(`imchat:${key}`).digest("hex");
  return SessionId(`session-${digest.slice(0, 26)}`);
}

/** Extract the last assistant text message from a session's events. */
function lastAssistantText(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const e = session.events[i];
    if (e.type === "assistant/message" && e.data.message?.content) {
      const text = e.data.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) return text;
    }
  }
  return undefined;
}

/** Bridge core: one AgentDriver per conversation key, serialized per driver. */
async function createBridge(ctx) {
  const agents = ctx.get("agents");
  const model = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  if (!agents || !model || !sessions) throw new Error("imchat: core services unavailable");

  const selection = model.currentSelection();
  const drivers = new Map();

  async function driverFor(key) {
    let driver = drivers.get(key);
    if (driver) return driver;
    const { agent } = await agents.create({
      sessionId: sessionIdFor(key),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, {
          current: selection,
          assembled: undefined,
        });
      },
    });
    driver = {
      agent,
      tail: undefined,
    };
    drivers.set(key, driver);
    return driver;
  }

  // Serialize per conversation: only one turn at a time per driver.
  // Simplest correct form: chain onto the previous task's tail.
  function enqueue(driver, task) {
    const prev = driver.tail ?? Promise.resolve();
    const run = prev.then(async () => {
      try {
        await task();
      } catch (err) {
        ctx.logger.error(`imchat: driver task failed: ${String(err)}`);
      }
    });
    driver.tail = run;
    return run;
  }

  async function handle(msg, send) {
    const driver = await driverFor(msg.conversationKey);
    await enqueue(driver, async () => {
      // PROBE v0
      ctx.logger.info(`imchat: driving agent for ${msg.conversationKey}`);
      driver.agent.followup(userMessage(msg.text));
      await driver.agent.whenIdle();
      ctx.logger.info(`imchat: agent idle, seq=${driver.agent.session.seq}`);
      const reply = lastAssistantText(driver.agent.session);
      if (reply) await send(reply);
    });
  }

  return {
    handle,
    async stop() {
      await Promise.allSettled([...drivers.values()].map((d) => d.tail ?? Promise.resolve()));
    },
  };
}

/** Zero-dependency demo adapter: waits for lines on stdin, prints replies. */
async function startConsoleAdapter(ctx, bridge) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    bridge
      .handle(
        {
          platform: "console",
          account: "stdin",
          conversationKey: "default",
          text,
          sender: "stdin",
        },
        async (reply) => ctx.stdout ? ctx.stdout.write(`[reply] ${reply}\n`) : process.stdout.write(`[reply] ${reply}\n`),
      )
      .catch((err) => process.stderr.write(`imchat: ${String(err)}\n`));
  });
  rl.on("close", () => process.stdout.write("imchat: stdin closed\n"));
  ctx.logger.info("imchat: console adapter started");
  return rl;
}

/** Cordis plugin entry. Sync apply; heavy work is fired asynchronously. */
function apply(ctx, config) {
  const program = new Command()
    .name("dsh --profile imchat")
    .aliases(["imchat"])
    .helpOption(false)
    .argument("[text...]", "self-test prompt text")
    .option("--self-test", "run one message through the bridge, print the reply, and exit")
    .action(() => {
      // PROBE v0
      process.stderr.write(`[imchat] action selfTest=${program.getOptionValue("selfTest")} args=${JSON.stringify(program.args)}\n`);
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

async function runSelfTest(ctx, config, text) {
  // PROBE v0
  process.stderr.write(`[imchat] runSelfTest entered\n`);
  const agents = ctx.get("agents");
  const model = ctx.get("agentDefaultModel");
  process.stderr.write(`[imchat] agents=${!!agents} model=${!!model} selection=${JSON.stringify(model?.currentSelection())}\n`);
  if (!agents || !model) return;
  const selection = model.currentSelection();
  const { agent } = await agents.create({
    sessionId: sessionIdFor("self", true),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    },
  });
  process.stderr.write(`[imchat] agent created, id=${agent.id} loop=${!!agent.followup}\n`);
  agent.followup(userMessage(text));
  await agent.whenIdle();
  process.stderr.write(`[imchat] agent idle seq=${agent.session.seq}\n`);
  for (const e of agent.session.events.slice(-8)) {
    process.stderr.write(`  event ${e.seq} ${e.type} ${JSON.stringify(e.data).slice(0, 200)}\n`);
  }
  const reply = lastAssistantText(agent.session);
  process.stderr.write(`[imchat] reply=${reply ? JSON.stringify(reply.slice(0, 60)) : "(none)"}\n`);
  process.stdout.write((reply ?? "(no reply)") + "\n");
}

async function startLongRunning(ctx, config) {
  const bridge = await createBridge(ctx);
  const adapters = config.adapters ?? ["console"];
  const disposers = [];
  for (const id of adapters) {
    if (id === "console") {
      disposers.push(await startConsoleAdapter(ctx, bridge));
    } else {
      ctx.logger.warn(`imchat: unknown adapter "${id}" ignored`);
    }
  }
  ctx.effect(() => {
    for (const d of disposers) try { d.close?.(); } catch {}
    bridge.stop().catch(() => {});
  });
}

const Config = z.object({ adapters: z.array(z.string()).default(["console"]) });

/** Required core services; the loader validates and injects them. */
export const inject = ["agents", "sessions", "agentDefaultModel", "cmdlineArgs", "appExit"];

export { Config, apply, name };
