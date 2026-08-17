/**
 * @module imchat/adapters/feishu/protocol
 *
 * Pure Feishu open-platform wire calls (HTTP + WebSocket), plus message
 * helpers. No Node-specific imports — entirely testable in isolation.
 *
 * Endpoints (verified against open.feishu.cn on 2026-08-17):
 *   - Tenant token  https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
 *   - Long-connection bootstrap (获得长连接)  POST https://open.feishu.cn/callback/ws/endpoint
 *     body { AppID, AppSecret } → { code: 0, data: { URL, ClientConfig } }
 *     (the historical "ws/v1/apps/:app_id/client" GET path now returns 404)
 *   - Send            https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id
 *   - Reply           https://open.feishu.cn/open-apis/im/v1/messages/:message_id/reply
 *
 * The long connection transports events over a WebSocket. The official SDKs
 * speak protobuf frames (schema below); this adapter uses the equivalent
 * protobuf-free JSON frame mapping (frame ↔ JSON is a bijection), which the
 * gateway historically accepted. Each frame:
 *
 *   { SeqID, LogID, service, method, headers: [{key,value}...],
 *     payload_encoding?, payload_type?, payload?, LogIDNew? }
 *
 *   method 0 = control (type: ping/pong), 1 = data (type: event/card)
 *   payload of ping/pong is JSON text; control frames are text frames.
 *   Data event payload is the raw `im.message.receive_v1` envelope JSON.
 *

 */

/** Default Feishu (CN) API base domain. International (Lark) tenants use
 *  `https://open.larksuite.com`; pass a `domain` override when needed. */
export const FEISHU_API_BASE = "https://open.feishu.cn";

/** Cap for a text content piece sent through im/v1 (official limit 150KB; we
 * are far more conservative so a huge reply is chunked well under it). */
export const MAX_TEXT_LENGTH = 30000;

// Frame layout mirrors pbbp2.Frame (larksuite/oapi-sdk). Kept here so the
// JSON wire format is documented in one place.
export const FrameMethod = Object.freeze({
  CONTROL: 0,
  DATA: 1,
});
export const MessageType = Object.freeze({
  EVENT: "event",
  CARD: "card",
  PING: "ping",
  PONG: "pong",
});
export const HeaderKey = Object.freeze({
  TYPE: "type",
  MESSAGE_ID: "message_id",
  SUM: "sum",
  SEQ: "seq",
  TRACE_ID: "trace_id",
  BIZ_RT: "biz_rt",
  HANDSHAKE_STATUS: "Handshake-Status",
  HANDSHAKE_MSG: "Handshake-Msg",
  HANDSHAKE_AUTH_ERRCODE: "Handshake-Autherrcode",
});

/** Standard error used across the adapter when the API reports a non-zero
 *  business code. */
export class FeishuApiError extends Error {
  constructor(code, msg, detail = {}) {
    super(`feishu api error ${code}: ${msg}`);
    this.name = "FeishuApiError";
    this.code = code;
    this.msg = msg;
    this.detail = detail;
  }
}

function assertOk(status, code, msg, detail) {
  if (status !== 0) throw new FeishuApiError(status ?? -1, msg ?? "unknown", detail);
}

/**
 * POST JSON to a Feishu endpoint. `authToken` (tenant_access_token) is set as
 * `Authorization: Bearer …` when provided; otherwise the call is token-less.
 */
export async function apiPost(baseUrl, path, body, { token, headers = {}, signal } = {}) {
  const h = { "Content-Type": "application/json; charset=utf-8", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new Error(`feishu http ${path}: ${String(err?.message ?? err)}`);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new FeishuApiError(res.status, `non-JSON response (HTTP ${res.status})`, { path });
  }
  if (res.ok && json.code === 0) return json;
  // Surface non-OK HTTP as errors too.
  if (!res.ok) {
    throw new FeishuApiError(json.code ?? res.status, json.msg ?? `HTTP ${res.status}`, { path, httpStatus: res.status });
  }
  throw new FeishuApiError(json.code, json.msg, { path, httpStatus: res.status });
}

/**
 * Fetch a tenant access token.
 * POST /open-apis/auth/v3/tenant_access_token/internal
 * body { app_id, app_secret } → { tenant_access_token, expire }
 */
export async function getTenantAccessToken(appId, appSecret, { baseUrl = FEISHU_API_BASE, signal } = {}) {
  const json = await apiPost(
    baseUrl,
    "/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: appId, app_secret: appSecret },
    { signal },
  );
  return {
    token: json.tenant_access_token,
    // Officially ≤ 2h; we renew early (85%) to avoid races.
    expiresAt: Date.now() + (json.expire ?? 7200) * 1000 * 0.85,
  };
}

/**
 * Obtain the long-connection WebSocket URL + server-suggested client config.
 * POST /callback/ws/endpoint  body { AppID, AppSecret, ClientAssertion? }
 * → { code, data: { URL, ClientConfig? } }
 * (Legacy GET /open-apis/ws/v1/apps/<app_id>/client returns 404; see README.)
 */
export async function getLongConnectionUrl(appId, appSecret, { baseUrl = FEISHU_API_BASE, headers = {}, signal } = {}) {
  const json = await apiPost(
    baseUrl,
    "/callback/ws/endpoint",
    { AppID: appId, AppSecret: appSecret },
    { headers: { locale: "zh", "User-Agent": "imchat/0.1", ...headers }, signal },
  );
  const data = json.data ?? {};
  if (!data.URL) throw new FeishuApiError(-1, "long connection endpoint returned no URL", { data });
  return {
    url: data.URL,
    clientConfig: data.ClientConfig ?? {},
  };
}

/** Build the standard text content payload for im/v1 (msg_type=text). */
export function textContent(text) {
  return JSON.stringify({ text: String(text) });
}

/**
 * Reply to a specific inbound message (keeps thread continuity).
 * POST /open-apis/im/v1/messages/:message_id/reply
 * body { content, msg_type, reply_in_thread? }
 */
export async function sendReply(token, messageId, text, { baseUrl = FEISHU_API_BASE, replyInThread = true, signal } = {}) {
  const json = await apiPost(
    baseUrl,
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
    { content: textContent(text), msg_type: "text", reply_in_thread: replyInThread },
    { token, signal },
  );
  return json.data ?? {};
}

/**
 * Send a text message into a chat (p2p or group) by chat_id.
 * POST /open-apis/im/v1/messages?receive_id_type=chat_id
 * body { receive_id, content, msg_type }
 */
export async function sendToChat(token, chatId, text, { baseUrl = FEISHU_API_BASE, signal } = {}) {
  const json = await apiPost(
    baseUrl,
    "/open-apis/im/v1/messages?receive_id_type=chat_id",
    { receive_id: chatId, content: textContent(text), msg_type: "text" },
    { token, signal },
  );
  return json.data ?? {};
}

/**
 * Chunk an overlong reply into safe per-message pieces. `max` defaults to the
 * Feishu safe limit; total bytes are recomputed after JSON escaping so we
 * never exceed it even for unicode/multibyte content.
 */
export function splitText(text, max = MAX_TEXT_LENGTH) {
  return splitByUtf8(text, max);
}

/**
 * UTF-8-aware chunker. We measure the *wire* length (post `textContent`
 * escaping) rather than JS string length, because a JSON-escaped multibyte
 * string is larger on the wire. Returns an array of substrings; each piece
 * re-serialized as a text payload is ≤ max UTF-8 bytes.
 * Prefers splitting on newlines / whitespace; falls back to hard cut.
 */
export function splitByUtf8(text, max = MAX_TEXT_LENGTH) {
  const s = String(text ?? "");
  const enc = new TextEncoder();
  if (enc.encode(JSON.stringify({ text: s })).length <= max) return [s];

  const chunks = [];
  let rest = s;
  while (rest.length > 0) {
    // Binary-search the longest prefix whose payload fits.
    let lo = 1;
    let hi = rest.length;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const wire = enc.encode(JSON.stringify({ text: rest.slice(0, mid) })).length;
      if (wire <= max) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    let cut = best;
    // Prefer a natural break (newline / whitespace) near the boundary.
    const nl = rest.lastIndexOf("\n", cut);
    if (nl > Math.floor(cut * 0.5)) cut = nl + 1;
    else {
      const sp = rest.lastIndexOf(" ", cut);
      if (sp > Math.floor(cut * 0.5)) cut = sp + 1;
    }
    let piece = rest.slice(0, cut);
    // Do not leave dangling whitespace at a chunk edge.
    while (chunks.length > 0 && /[ \t]\.?$/.test(piece) && piece.length > 1) piece = piece.trimEnd();
    if (!piece && rest) piece = rest[0];
    chunks.push(piece);
    rest = rest.slice(piece.length).trimStart();
  }
  return chunks.filter((c) => c.length > 0);
}

/** Encode an outbound WebSocket frame (control ping/pong or event ack) as JSON text. */
export function encodeFrame({ method = FrameMethod.CONTROL, type, payload, service = 0, seqId = 0, logId = "0" }) {
  const headers = [{ key: HeaderKey.TYPE, value: type }];
  const frame = { SeqID: seqId, LogID: logId, service, method, headers };
  if (payload !== undefined) {
    frame.payload = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (typeof payload !== "string") frame.payload_type = "json";
  }
  return JSON.stringify(frame);
}

/** Build a ping control frame (per server ping interval). */
export function pingFrame(service = 0) {
  return encodeFrame({ method: FrameMethod.CONTROL, type: MessageType.PING, service });
}

/** Build the JSON ack for an inbound event (HTTP 200 style, per SDK). */
export function eventAckFrame(service = 0) {
  const payload = JSON.stringify({ code: 200 });
  return encodeFrame({ method: FrameMethod.CONTROL, type: MessageType.PONG, payload, service });
}

/** Extract a text payload from the JSON `{"text":"..."}` convention. */
export function parseTextContent(content) {
  if (typeof content !== "string") return String(content ?? "");
  try {
    const o = JSON.parse(content);
    if (o && typeof o.text === "string") return o.text;
  } catch {
    /* not JSON text content — fall through */
  }
  return content;
}
