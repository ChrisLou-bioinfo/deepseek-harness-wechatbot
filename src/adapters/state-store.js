import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STATE_DIR = path.join(REPO_ROOT, "state");

function accountPath(platform, account) {
  return path.join(STATE_DIR, `${platform}-${sanitize(account)}.json`);
}

function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function loadState(platform, account) {
  try {
    const raw = fs.readFileSync(accountPath(platform, account), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveState(platform, account, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(accountPath(platform, account), JSON.stringify(state, null, 2), "utf8");
}
