/**
 * Shared reply utilities used by all adapters.
 */

/** Chunk overlong text for platforms with per-message limits. */
export function splitText(text, max = 30000) {
  const s = String(text ?? "");
  if (s.length <= max) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > max) {
    // Prefer splitting at a newline / whitespace near the limit.
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Stable unique client-side id per platform message. */
export function generateClientId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** Exponential backoff with jitter for reconnect loops. */
export function backoffDelayMs(attempt, baseMs = 500, capMs = 30000) {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = 0.8 + Math.random() * 0.4; // 0.8..1.2
  return Math.min(exp * jitter, capMs);
}
