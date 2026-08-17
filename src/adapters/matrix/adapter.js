import { loadState, saveState } from "../state-store.js";
import { login, syncOnce, sendText, sendTyping } from "./protocol.js";
import { backoffDelayMs } from "../../lib/utils.js";

/**
 * Matrix adapter — native account, Client-Server API long-poll (/sync).
 *   start(ctx, { onMessage }) → disposer
 *   send(ctx, msg, replyText) → Promise
 * conversationKey = roomId. Ignores own messages and non-text types.
 */

const matrixAdapter = {
  id: "matrix",
  label: "Matrix (Client-Server /sync)",
  async start(ctx, { onMessage }, accountConfig = {}) {
    const log = (m) => process.stderr.write(`[matrix:${accountConfig.name ?? "default"}] ${m}\n`);
    const config = { name: "default", ...accountConfig };
    if (!config.homeserver) throw new Error(`matrix: account "${config.name}" needs homeserver config`);

    const ctl = new AbortController();
    runAccount(config, onMessage, log, ctl.signal).catch((err) => log(`account stopped: ${String(err)}`));

    return { close: () => ctl.abort() };
  },

  async send(ctx, msg, replyText) {
    const account = msg.account;
    const st = loadState("matrix", account);
    if (!st.token) throw new Error(`matrix: no token for account "${account}"`);
    await sendText({
      homeserver: st.homeserver,
      token: st.token,
      roomId: msg.conversationKey,
      txnId: `imchat-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      text: replyText,
    });
  },
};

async function runAccount(config, onMessage, log, signal) {
  const name = config.name;
  let state = loadState("matrix", name) || {};
  let token = config.accessToken || state.token;
  let homeserver = (config.homeserver || state.homeserver || "").replace(/\/+$/, "");
  if (!token) {
    // full login (password) once
    const loginResult = await login({
      homeserver,
      userId: config.userId,
      password: config.password,
    });
    token = loginResult.access_token;
    state = { ...state, token, homeserver, userId: loginResult.user_id ?? config.userId, savedAt: new Date().toISOString() };
    saveState("matrix", name, state);
    log(`logged in as ${state.userId}`);
  }

  let since = state.since ?? undefined;
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const { nextBatch, events } = await syncOnce({ homeserver, token, since, timeoutMs: 30_000, signal });
      attempt = 0;
      since = nextBatch;
      state = { ...state, token, homeserver, since };
      saveState("matrix", name, state);
      for (const ev of events) handleEvent(ev, config.userId ?? "", onMessage, accountName(name));
    } catch (err) {
      if (signal.aborted) break;
      if (err.retryAfterMs) {
        await sleep(err.retryAfterMs, signal);
        continue;
      }
      if (err.auth) {
        log(`sync auth failure; will retry with backoff`);
      }
      attempt++;
      const delay = backoffDelayMs(attempt);
      log(`sync failed (${attempt}): ${String(err.message ?? err)} — retry in ${Math.round(delay)}ms`);
      await sleep(delay, signal);
    }
  }
}

function handleEvent(ev, selfUserId, onMessage, account) {
  if (ev.type !== "m.room.message") return;
  if (ev.sender === selfUserId) return; // own message
  const content = ev.content ?? {};
  if (content.msgtype !== "m.text") return;
  const body = String(content.body ?? "").trim();
  if (!body) return;
  onMessage({
    platform: "matrix",
    account,
    conversationKey: ev.roomId,
    text: content.format === "org.matrix.custom.html" && content.formatted_body ? stripHtml(content.formatted_body) : body,
    sender: ev.sender,
  });
}

function stripHtml(html) {
  return String(html).replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}

function accountName(name) {
  return name;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export { matrixAdapter };
