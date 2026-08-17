import { createHash, randomBytes } from "node:crypto";

/**
 * WeChat "ilink" official bot protocol over plain HTTP JSON.
 * Ported faithfully (wire shapes) from Tencent openclaw-weixin (MIT):
 *   endpoints under `ilink/bot/*`, every body carries `base_info`,
 *   headers carry iLink-App-Id / iLink-App-ClientVersion / X-WECHAT-UIN.
 * See https://github.com/Tencent/openclaw-weixin
 */

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const LONG_POLL_TIMEOUT_MS = 35_000;
export const STALE_TOKEN_ERRCODE = -14;

// Upstream openclaw-weixin ships `ilink_appid: "bot"`, version 2.4.6.
// Client version is encoded as 0x00MMNNPP.
const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "imchat-0.1.0";
function buildClientVersion() {
  return 2 << 16 | 4 << 8 | 6; // 2.4.6
}
const ILINK_APP_CLIENT_VERSION = buildClientVersion();

export const MessageItemType = Object.freeze({ TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 });
export const MessageType = Object.freeze({ USER: 1, BOT: 2 });
export const MessageState = Object.freeze({ NEW: 0, GENERATING: 1, FINISH: 2 });

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildCommonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token && String(token).trim()) headers.Authorization = `Bearer ${String(token).trim()}`;
  return headers;
}

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: "imchat/0.1.0" };
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Low-level POST to the ilink gateway. `timeoutMs` aborts a stalled request
 * (a long-poll timing out is NORMAL control flow — callers treat it as retry).
 * Returns parsed JSON; throws on HTTP/network errors and non-2xx.
 */
export async function apiPostFetch({ baseUrl, endpoint, body, token, timeoutMs, label = endpoint, abortSignal }) {
  const base = ensureTrailingSlash(baseUrl);
  const url = new URL(endpoint, base);
  const hdrs = buildHeaders(token);
  const controller = timeoutMs !== undefined ? new AbortController() : undefined;
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const onOuter = () => controller?.abort();
  abortSignal?.addEventListener("abort", onOuter, { once: true });
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t) clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) throw new Error(`${label} ${res.status}: ${rawText}`);
    return rawText;
  } catch (err) {
    if (err.name === "AbortError") {
      const abortErr = new Error(`${label} aborted`);
      abortErr.name = "AbortError";
      throw abortErr;
    }
    throw err;
  } finally {
    if (t) clearTimeout(t);
    abortSignal?.removeEventListener("abort", onOuter);
  }
}

/** Wrap apiPostFetch into a parsed-JSON helper used by typed calls. */
export async function apiPostJson({ baseUrl, token, endpoint, body, timeoutMs, label, abortSignal }) {
  const raw = await apiPostFetch({ baseUrl, token, endpoint, body, timeoutMs, label, abortSignal });
  return JSON.parse(raw);
}

/**
 * Long-poll getUpdates. A long-poll timeout is NORMAL: returns an empty
 * {ret:0, msgs:[], get_updates_buf} so the caller retries with the same cursor.
 * Throws on protocol ret!==0 and on HTTP errors.
 */
export async function getUpdates(baseUrl, token, getUpdatesBuf, { timeoutMs = LONG_POLL_TIMEOUT_MS, abortSignal } = {}) {
  try {
    const json = await apiPostJson({
      baseUrl,
      token,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: getUpdatesBuf ?? "", base_info: buildBaseInfo() },
      timeoutMs,
      label: "getUpdates",
      abortSignal,
    });
    if (json.ret && json.ret !== 0) {
      const err = new Error(`getUpdates ret=${json.ret} errmsg=${json.errmsg ?? ""} errcode=${json.errcode ?? ""}`);
      err.ret = json.ret;
      throw err;
    }
    return {
      msgs: Array.isArray(json.msgs) ? json.msgs : [],
      getUpdatesBuf: json.get_updates_buf ?? getUpdatesBuf ?? "",
      isNew: json.is_new === true,
      json,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      // client-side timeout → normal control flow
      return { msgs: [], getUpdatesBuf: getUpdatesBuf ?? "", isNew: false, json: { ret: 0 } };
    }
    throw err;
  }
}

export async function sendMessage(baseUrl, token, body, opts = {}) {
  await apiPostFetch({
    baseUrl,
    token,
    endpoint: "ilink/bot/sendmessage",
    body: { ...body, base_info: buildBaseInfo() },
    timeoutMs: opts.timeoutMs ?? 15_000,
    label: "sendMessage",
    abortSignal: opts.abortSignal,
  });
}

export async function getUploadUrl(baseUrl, token, params, opts = {}) {
  return apiPostJson({
    baseUrl,
    token,
    endpoint: "ilink/bot/getuploadurl",
    body: { ...params, base_info: buildBaseInfo() },
    timeoutMs: opts.timeoutMs ?? 15_000,
    label: "getUploadUrl",
    abortSignal: opts.abortSignal,
  });
}

export async function getConfig(baseUrl, token, { ilinkUserId, contextToken }, opts = {}) {
  return apiPostJson({
    baseUrl,
    token,
    endpoint: "ilink/bot/getconfig",
    body: { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: buildBaseInfo() },
    timeoutMs: opts.timeoutMs ?? 10_000,
    label: "getConfig",
    abortSignal: opts.abortSignal,
  });
}

export async function sendTyping(baseUrl, token, body, opts = {}) {
  await apiPostFetch({
    baseUrl,
    token,
    endpoint: "ilink/bot/sendtyping",
    body: { ...body, base_info: buildBaseInfo() },
    timeoutMs: opts.timeoutMs ?? 10_000,
    label: "sendTyping",
    abortSignal: opts.abortSignal,
  });
}

export async function notifyStart(baseUrl, token, opts = {}) {
  return apiPostJson({
    baseUrl,
    token,
    endpoint: "ilink/bot/msg/notifystart",
    body: { base_info: buildBaseInfo() },
    timeoutMs: opts.timeoutMs ?? 10_000,
    label: "notifyStart",
    abortSignal: opts.abortSignal,
  });
}

export async function notifyStop(baseUrl, token, opts = {}) {
  return apiPostJson({
    baseUrl,
    token,
    endpoint: "ilink/bot/msg/notifystop",
    body: { base_info: buildBaseInfo() },
    timeoutMs: opts.timeoutMs ?? 10_000,
    label: "notifyStop",
    abortSignal: opts.abortSignal,
  });
}

/** Extract the plain text body of an inbound WeixinMessage, or "" for media-only. */
export function extractText(itemList = []) {
  for (const item of itemList) {
    if (item?.type === MessageItemType.TEXT && item.text_item?.text != null) return String(item.text_item.text);
  }
  return "";
}

export { buildBaseInfo as _buildBaseInfo, buildHeaders as _buildHeaders };
