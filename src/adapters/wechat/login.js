import qrcode from "qrcode-terminal";
import { apiPost } from "./protocol.js";

/**
 * WeChat QR login flow (ilink). Communicate with the auth gateway:
 *   1. get_bot_qrcode?bot_type=3 → { qrcode, qrcode_img_content }
 *   2. poll get_qrcode_status?qrcode=<id> (long-poll ~35s) → status/bot_token/baseurl
 * On "confirmed" the caller persists token+baseUrl+user.
 * Handles the IDC redirect: on scaned_but_redirect, switch host to redirect_host.
 */

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const QR_POLL_TIMEOUT_MS = 35_000;

/** Request a fresh QR code. */
export async function fetchQRCode(baseUrl = FIXED_BASE_URL, botType = DEFAULT_BOT_TYPE) {
  const json = await apiPost(baseUrl, "", `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {}, { includeUin: true });
  return { qrcode: json.qrcode, qrcodeImg: json.qrcode_img_content, baseUrl };
}

async function pollStatus(baseUrl, qrcode, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  return apiPost(baseUrl, "", endpoint, {}, { timeoutMs: QR_POLL_TIMEOUT_MS, includeUin: true });
}

function printQR(qrcodeImg) {
  // qrcode-terminal expects the QR ascii art or the raw string; the ilink
  // payload `qrcode_img_content` is itself a QR ASCII block — print directly.
  if (qrcodeImg && /[▄▀█]/.test(qrcodeImg)) {
    process.stderr.write(qrcodeImg + "\n");
    return;
  }
  if (qrcodeImg && qrcodeImg.startsWith("http")) {
    qrcode.generate(qrcodeImg, { small: true }, (s) => process.stderr.write(s));
    return;
  }
  process.stderr.write(qrcodeImg + "\n");
}

const STATUS_LABEL = {
  wait: "等待扫码…",
  scaned: "已扫码,等待确认…",
  confirmed: "已确认 ✓",
  expired: "二维码已过期,重新获取",
  scaned_but_redirect: "已扫码,重定向到新机房…",
  need_verifycode: "需要配对码",
  verify_code_blocked: "配对码被拒绝",
  binded_redirect: "已绑定,跳转…",
};

/**
 * Run the interactive QR login. Calls `onToken({ token, baseUrl, user })`
 * once confirmed. Returns a promise that resolves with the confirmed account
 * or rejects on expiry failure after a bounded number of attempts.
 * An AbortSignal can cancel an in-progress scan.
 */
export async function runQRLogin(opts = {}) {
  const {
    baseUrl = FIXED_BASE_URL,
    botType = DEFAULT_BOT_TYPE,
    startQr,
    print = printQR,
    log = (m) => process.stderr.write(`[wechat-login] ${m}\n`),
    maxAttempts = 3,
    signal,
  } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("login aborted");
    if (attempt > 1) log(`重试第 ${attempt} 次…`);
    const { qrcode, qrcodeImg, baseUrl: effectiveBase } = await fetchQRCode(baseUrl, botType);
    startQr?.({ qrcodeImg, baseUrl: effectiveBase });
    print(qrcodeImg);

    let currentBase = effectiveBase;
    let pendingVerifyCode;
    for (let poll = 0; poll < 60; poll++) {
      if (signal?.aborted) throw signal.reason ?? new Error("login aborted");
      const status = await pollStatus(currentBase, qrcode, pendingVerifyCode);
      const state = status.status;
      if (state === "confirmed") {
        if (!status.bot_token) throw new Error("login confirmed but no bot_token returned");
        const user = status.ilink_user_id ?? "";
        log("扫码成功,已获取 token");
        return { token: status.bot_token, baseUrl: status.baseurl || currentBase, user };
      }
      if (state === "scaned_but_redirect" && status.redirect_host) {
        log(`切换到 ${status.redirect_host}`);
        currentBase = `https://${status.redirect_host}`;
      } else if (state === "need_verifycode") {
        // pairing code submission; keep same plaza until user supplies it
        // (v1: no interactive prompt; just keep polling)
      } else if (state === "expired") {
        break; // try next attempt with a fresh QR
      }
      log(STATUS_LABEL[state] ?? `状态:${state}`);
      // the poll request already long-polls up to 35s server-side
    }
  }
  throw new Error("微信扫码登录超时,请重试");
}
