/**
 * Matrix Client-Server API wire helpers (option A: native account + /sync).
 * Uses global fetch only. Endpoints per https://spec.matrix.org/latest/
 */

/** POST /_matrix/client/v3/login with m.login.password (or token login). */
export async function login({ homeserver, userId, password, accessToken }) {
  const url = `${homeserver}/_matrix/client/v3/login`;
  const body = accessToken
    ? undefined
    : {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: userId },
        password,
      };
  // token login: if only accessToken given, skip login entirely.
  if (accessToken) return { access_token: accessToken, user_id: userId, device_id: "imchat" };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`matrix login failed HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("matrix login: no access_token");
  return json;
}

const SYNC_FILTER = encodeURIComponent(
  JSON.stringify({
    room: {
      timeline: { types: ["m.room.message"], limit: 30 },
      ephemeral: { types: ["m.typing"] },
    },
  }),
);

/**
 * Long-poll GET /_matrix/client/v3/sync. Returns { nextBatch, events } where
 * events is a flat list of timeline events from joined rooms.
 * `timeoutMs` becomes the server's hold time.
 */
export async function syncOnce({ homeserver, token, since, timeoutMs = 30_000, signal }) {
  const params = new URLSearchParams({ timeout: String(timeoutMs), filter: SYNC_FILTER });
  if (since) params.set("since", since);
  const url = `${homeserver}/_matrix/client/v3/sync?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`matrix sync auth failed HTTP ${res.status}`);
    err.auth = true;
    throw err;
  }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const err = new Error("matrix sync rate limited");
    err.retryAfterMs = body.retry_after_ms ?? 5000;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`matrix sync failed HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  const events = [];
  const rooms = json.rooms?.join ?? {};
  for (const [roomId, room] of Object.entries(rooms)) {
    for (const ev of room.timeline?.events ?? []) {
      events.push({ ...ev, roomId });
    }
  }
  return { nextBatch: json.next_batch, events };
}

/** PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId} */
export async function sendText({ homeserver, token, roomId, txnId, text, signal }) {
  const url = `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "m.text", body: String(text) }),
    signal,
  });
  if (!res.ok) {
    const textBody = await res.text();
    throw new Error(`matrix send failed HTTP ${res.status}: ${textBody}`);
  }
  return res.json();
}

/** PUT /_matrix/client/v3/rooms/{roomId}/typing/{userId} */
export async function sendTyping({ homeserver, token, roomId, userId, typing, signal }) {
  await fetch(`${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ typing, timeout: 10_000 }),
    signal,
  }).catch(() => {});
}
