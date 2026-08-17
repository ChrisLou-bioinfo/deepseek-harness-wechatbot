import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * WeChat "ilink" official bot protocol over plain HTTP JSON.
 * Ported from Tencent openclaw-weixin (MIT); wire shapes kept faithful,
 * no OpenClaw-isms. See https://github.com/Tencent/openclaw-weixin
 */

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export const MessageItemType = Object.freeze({
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
});

export const MessageType = Object.freeze({ USER: 1, BOT: 2 });
export const MessageState = Object.freeze({ NEW: 0, GENERATING: 1, FINISH: 2 });

function randomUin() {
  return Buffer.from(String(randomBytes(4).readUInt32LE(0))).toString("base64");
}

function headers(token, { includeUin = true } = {}) {
  const h = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
  };
  if (includeUin) h["X-WECHAT-UIN"] = randomUin();
  return h;
}

/**
 * Low-level POST to the ilink gateway. `timeoutMs` is a client-side abort so a
 * stalled long-poll cannot hang the loop. Throws on HTTP/network errors and
 * non-ret responses.
 */
export async function apiPost(baseUrl, token, endpoint, body, { timeoutMs = 20_000, includeUin = true, signal } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const onOuterAbort = () => ctl.abort(signal?.reason ?? new Error("aborted"));
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetch(`${baseUrl}/${endpoint}`, {
      method: "POST",
      headers: headers(token, { includeUin }),
      body: JSON.stringify(body ?? {}),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${endpoint}`);
    const json = await res.json();
    if (json.token) token = json.token; // some endpoints may rotate token
    return json;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Long-poll getUpdates. Server holds until messages arrive or longpolling timeout. */
export async function getUpdates(baseUrl, token, getUpdatesBuf, { timeoutMs = LONG_POLL_TIMEOUT_MS, signal } = {}) {
  const json = await apiPost(baseUrl, token, "getupdates", { get_updates_buf: getUpdatesBuf ?? "" }, { timeoutMs, signal });
  if ((json.ret ?? 0) !== 0) {
    const err = new Error(`getUpdates failed ret=${json.ret} errmsg=${json.errmsg ?? ""} errcode=${json.errcode ?? ""}`);
    err.ret = json.ret;
    throw err;
  }
  return {
    msgs: Array.isArray(json.msgs) ? json.msgs : [],
    getUpdatesBuf: json.get_updates_buf ?? getUpdatesBuf ?? "",
    isNew: json.is_new === true,
  };
}

/** Send a message to a user (text in v1). context_token must echo the inbound one. */
export async function sendMessage(baseUrl, token, { to, text, contextToken, clientId }, opts = {}) {
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : [],
      ...(contextToken ? { context_token: contextToken } : {}),
    },
  };
  return apiPost(baseUrl, token, "sendmessage", body, opts);
}

export async function notifyStart(baseUrl, token, opts = {}) {
  return apiPost(baseUrl, token, "ilink/bot/msg/notifystart", {}, opts);
}

export async function notifyStop(baseUrl, token, opts = {}) {
  return apiPost(baseUrl, token, "ilink/bot/msg/notifystop", {}, opts);
}

/** Send a typing indicator; `active=false` cancels it. */
export async function sendTyping(baseUrl, token, { to, typingTicket, active }, opts = {}) {
  const body = {
    ilink_user_id: to,
    ...(typingTicket ? { typing_ticket: typingTicket } : {}),
    status: active ? 1 : 2,
  };
  return apiPost(baseUrl, token, "sendtyping", body, opts);
}

export async function getConfig(baseUrl, token, { to, contextToken }, opts = {}) {
  const body = { ilink_user_id: to, ...(contextToken ? { context_token: contextToken } : {}) };
  const json = await apiPost(baseUrl, token, "getconfig", body, opts);
  return { typingTicket: json.typing_ticket };
}

/** Extract the plain text body of an inbound WeixinMessage, or "" for media-only. */
export function extractText(itemList = []) {
  for (const item of itemList) {
    if (item?.type === MessageItemType.TEXT && item.text_item?.text != null) return String(item.text_item.text);
  }
  return "";
}

export function md5(data) {
  return createHash("md5").update(data).digest("hex");
}

export { headers as buildHeaders };
