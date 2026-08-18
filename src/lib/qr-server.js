import http from "node:http";
import { URL } from "node:url";
import qrcode from "qrcode-terminal";

/** Generate ascii QR via the callback API (promisify mishandles opts).
 *  `small:false` renders a larger matrix — easier for phone scanning. */
function generateAscii(text) {
  return new Promise((resolve, reject) => {
    const opts = { small: false };
    const inner = (out) => resolve(out);
    try {
      qrcode.generate(text, opts, inner);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * QR viewer host — a zero-dependency local HTTP service that renders the
 * current WeChat (and future platform) login QR code as an HTML page that
 * auto-refreshes. The IM adapters publish QR payloads into a shared in-process
 * store; this server serves them over http://127.0.0.1:<port>/qr.
 *
 * This gives a browser-facing scan surface from the `dsh --profile imchat`
 * process without building a full DSH client plugin.
 */

/** In-process QR store keyed by account id. */
const qrStore = new Map();

/** Called by adapters when a fresh QR becomes available. The WeChat backend
 *  returns `qrcode_img_content` as a liteapp URL — THE thing to scan. Encode
 *  that URL (falling back to the raw hash) into a scannable ascii QR. */
export function publishQR(key, payload) {
  const scanValue = payload?.qrcodeImg ?? payload?.qrcode; // URL has priority
  const store = { payload, at: Date.now() };
  qrStore.set(key, store); // serve the raw payload immediately
  if (scanValue) {
    try {
      generateAscii(scanValue).then((ascii) => {
        store.payload = { ...payload, qrcodeImg: ascii, raw: scanValue };
        qrStore.set(key, store);
      });
    } catch {}
  }
}

export function currentQR(key) {
  return qrStore.get(key);
}

/** Minimal HTML page showing the QR as monospace ASCII + a fallback.
 *  Auto-refetches every 2s so it always shows the latest scan state. */
function renderPage(key) {
  const entry = qrStore.get(key);
  const raw = entry?.payload?.raw ?? entry?.payload?.qrcodeImg;
  const rawIsUrl = typeof raw === "string" && /^https?:\/\//.test(raw);
  const qrDisplay = entry?.payload?.qrcodeImg ?? "(暂无二维码)";
  // Strip ANSI color escapes (qrcode-terminal emits \x1b[...m); keep only glyphs
  // and newlines so the browser renders a clean matrix.
  const clean = String(qrDisplay).replace(/\x1b\[[0-9;]*m/g, "");
  const escaped = clean
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>imchat 微信扫码登录</title>
<style>body{font-family:ui-monospace,Menlo,monospace;background:#111;color:#eee;display:flex;flex-direction:column;align-items:center;padding:1rem}
pre{background:#000;color:#0f0;padding:1rem;border-radius:8px;border:1px solid #333;line-height:1.1;letter-spacing:0.4px;font-size:13px;white-space:pre}
.status{color:#999;margin-top:0.6rem;font-size:12px}</style></head>
<body><h3 style="color:#fff;font-family:sans-serif;margin:0.4rem">微信扫码登录</h3>
<p style="color:#bbb;font-family:sans-serif;margin:0.2rem 0 0.8rem;font-size:13px">用手机微信「扫一扫」对准下方码并确认</p>
<pre>${escaped}</pre>
${rawIsUrl ? `<p style="color:#888;font-family:monospace;font-size:12px;word-break:break-all;max-width:560px">或浏览器打开:<a href="${raw}" style="color:#4af">${raw}</a><br>若本页扫码不识别,请直接打开上面的链接确认</p>` : ""}
<p class="status">码约 1 分钟有效;过期后本页自动刷新换新码。</p>
<script>setTimeout(()=>location.reload(), 30000)</script>
</body></html>`;
}

/**
 * Start the QR viewer server. Returns { port, close }.
 * Binds 127.0.0.1 only; default port 9000 (override with env IMCHAT_QR_PORT).
 */
export function startQRServer(port = Number(process.env.IMCHAT_QR_PORT ?? 9000)) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (pathname === "/qr" || pathname === "/" && process.env.IMCHAT_QR_INDEX === "1") {
      const key = "wechat";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderPage(key));
      return;
    }
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, accounts: [...qrStore.keys()] }));
      return;
    }
    res.writeHead(404); res.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ port, close: () => server.close() }));
  });
}
