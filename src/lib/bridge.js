import crypto from "node:crypto";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

export { createBridge, lastAssistantText, sessionIdFor, userMessage };

/** Build a UserMessage exactly like the headless runner does (native text source). */
function userMessage(text) {
  return createUserMessage({
    content: [{ type: "text", text: String(text) }],
    source: { kind: "user" },
  });
}

/** Deterministic session id from a conversation key (64-char-safe). */
function sessionIdFor(key, random = false) {
  const raw = random ? crypto.randomUUID() : key;
  const digest = crypto.createHash("sha1").update(`imchat:${raw}`).digest("hex");
  return SessionId(`session-${digest.slice(0, 26)}`);
}

/** Extract the last assistant text message from a session's events. */
function lastAssistantText(session) {
  const events = session.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "assistant/message") continue;
    const content = e.data.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) return text;
  }
  return undefined;
}

/**
 * Bridge core: owns one per-conversation DSH AgentDriver. Adapters call
 * {@link Bridge.handle} with normalized inbound messages and provide a `send`
 * callback the driver invokes with model replies.
 *
 * Session identity: deterministic per conversation key. On a fresh process we
 * resume if a durable log exists, else create — so persistence-backed restarts
 * keep history per conversation (S5). The `resume` pass uses the registered
 * session-persistence service; if none is mounted (no durable backend), we
 * fall back to random ids so an ephemeral bus never collides (the single-file
 * JSONL backend below is mounted by our bundle, so resume is the norm).
 */
async function createBridge(ctx, options = {}) {
  const agents = ctx.get("agents");
  const model = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  if (!agents || !model || !sessions) throw new Error("imchat: core services unavailable");
  const selection = model.currentSelection();
  const randomIds = options.randomIds === true;
  const drivers = new Map();

  /** Result: { agent, dispose }. dispose() tears the agent down (await handle Closure). */
  async function createOrResume(key) {
    const sessionId = sessionIdFor(key, randomIds);
    const setup = (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    };
    const agentOpts = {
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    };
    // resume semantics: try durable resume, fall back to fresh create.
    const persistence = sessions && ctx.get("sessionPersistence");
    if (!randomIds && persistence) {
      try {
        const handle = await agents.resume({ ...agentOpts, resumeSessionId: sessionId });
        return handle;
      } catch (err) {
        // ENOENT means no durable log — create fresh; other errors surface.
        if (!String(err.message).includes("ENOENT") && !/does not exist/i.test(String(err.message))) throw err;
      }
    }
    return agents.create(agentOpts);
  }

  async function driverFor(key) {
    let driver = drivers.get(key);
    if (driver) return driver;
    const handle = await createOrResume(key);
    driver = { agent: handle.agent, handle, tail: undefined };
    drivers.set(key, driver);
    return driver;
  }

  // Serialize per conversation: only one turn at a time per driver.
  function enqueue(driver, task) {
    const prev = driver.tail ?? Promise.resolve();
    const run = prev.then(async () => {
      try {
        await task();
      } catch (err) {
        ctx.logger?.error(`imchat: driver task failed: ${String(err)}`);
      }
    });
    driver.tail = run;
    return run;
  }

  async function handle(msg, send, opts = {}) {
    const driver = await driverFor(msg.conversationKey);
    await enqueue(driver, async () => {
      driver.agent.followup(userMessage(msg.text));
      await driver.agent.whenIdle();
      const reply = lastAssistantText(driver.agent.session);
      if (reply) await send(reply);
      if (opts.onTurnEnd) {
        const end = [...driver.agent.session.events].reverse().find((e) => e.type === "turn/end");
        opts.onTurnEnd({ reply, end });
      }
    });
  }

  return {
    handle,
    async stop() {
      await Promise.allSettled([...drivers.values()].map((d) => d.tail ?? Promise.resolve()));
      for (const d of drivers.values()) {
        try {
          if (d.handle?.dispose) await d.handle.dispose();
        } catch {}
      }
      drivers.clear();
    },
  };
}
