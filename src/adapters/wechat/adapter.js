import { loadState, saveState } from "../state-store.js";
import { getUpdates, sendMessage, notifyStart, notifyStop, extractText } from "./protocol.js";
import { runQRLogin } from "./login.js";

/**
 * WeChat adapter — official ilink protocol (no wechaty).
 * Adapter contract:
 *   start(ctx, { onMessage }) → disposer     (never throws; logs instead)
 *   send(ctx, msg, replyText) → Promise<void>
 * Inbound msg normalized: { platform, account, conversationKey, text, sender }.
 * conversationKey = from_user_id. Outbound echoes the stored context_token.
 */

const STALE_TOKEN_ERRCODE = -14;
const PAUSE_MS = 60 * 60 * 1000;
const LONG_POLL_MS = 35_000;

const wechatAdapter = {
  id: "wechat",
  label: "WeChat (ilink official bot)",
  async start(ctx, { onMessage }, accountConfig = {}) {
    const log = (m) => process.stderr.write(`[wechat:${accountConfig.name ?? "default"}] ${m}\n`);
    const name = accountConfig.name ?? ctx.config?.name ?? "default";
    const accounts = Array.isArray(accountConfig.accounts) ? accountConfig.accounts : [{ name, ...accountConfig }];
    const controllers = [];

    for (const acct of accounts) {
      const acctName = acct.name ?? "default";
      const ctl = new AbortController();
      controllers.push(ctl);
      runAccount(acct, acctName, onMessage, log, ctl.signal).catch((err) => log(`account stopped: ${String(err)}`));
    }

    return {
      close() {
        for (const c of controllers) c.abort();
      },
    };
  },

  async send(ctx, msg, replyText) {
    const { account } = msg;
    const st = loadState("wechat", account);
    if (!st.token) throw new Error(`wechat: no token for account "${account}"`);
    const contextToken = st.contextTokens?.[msg.conversationKey];
    await sendMessage(st.baseUrl, st.token, {
      to: msg.conversationKey,
      text: replyText,
      contextToken,
      clientId: `imchat-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    });
  },
};

async function runAccount(config, name, onMessage, log, signal) {
  let state = loadState("wechat", name) || {};
  let token = config.token || state.token;
  let baseUrl = config.baseUrl || state.baseUrl;

  if (!token) {
    log("需要扫码登录微信…");
    const loginResult = await runQRLogin({ signal, startQr: () => {} });
    token = loginResult.token;
    baseUrl = loginResult.baseUrl || baseUrl;
    state = { ...state, token, baseUrl, user: loginResult.user, savedAt: new Date().toISOString() };
    saveState("wechat", name, state);
    log("登录成功,已保存 token");
  }

  // notifyStart so the backend streams pending messages to us.
  try {
    await notifyStart(baseUrl, token);
  } catch (err) {
    log(`notifyStart failed: ${String(err)}`);
  }

  let cursor = state.cursor ?? "";
  let failures = 0;
  let pausedUntil = 0;

  while (!signal.aborted) {
    const now = Date.now();
    if (now < pausedUntil) {
      await delay(pausedUntil - now, signal);
      continue;
    }
    try {
      const res = await getUpdates(baseUrl, token, cursor, { timeoutMs: LONG_POLL_MS, signal });
      cursor = res.getUpdatesBuf;
      state = { ...state, cursor, token, baseUrl };
      saveState("wechat", name, state);
      failures = 0;
      for (const m of res.msgs) {
        await handleInbound(m, name, onMessage, { state, token, baseUrl });
      }
    } catch (err) {
      const code = err?.ret ?? err?.errcode;
      if (code === STALE_TOKEN_ERRCODE) {
        log(`token 过期(-14),暂停接收 1 小时;扫码 / 重新部署后恢复`);
        pausedUntil = Date.now() + PAUSE_MS;
        continue;
      }
      failures++;
      log(`getUpdates failed (${failures}): ${String(err.message ?? err)}`);
      if (failures >= 5) {
        await delay(10_000, signal);
        failures = 0;
      }
    }
  }
  try { await notifyStop(baseUrl, token); } catch {}
}

async function handleInbound(m, account, onMessage, { state, token, baseUrl }) {
  const from = m.from_user_id;
  const text = extractText(m.item_list);
  // refresh context token store (echo on outbound)
  if (from && m.context_token) {
    const tokens = { ...(state?.contextTokens || {}), [from]: m.context_token };
    saveState("wechat", account, { ...state, contextTokens: tokens, token, baseUrl });
  }
  if (!from) return;
  if (!text) return; // media-only ignored in v1
  onMessage({
    platform: "wechat",
    account,
    conversationKey: from,
    text,
    sender: from,
  });
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export { wechatAdapter };
