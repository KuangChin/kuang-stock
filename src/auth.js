// 密碼登入與簽章 cookie。只用 Web Crypto，所以 Node 伺服器、Vercel function、Edge middleware 都能共用。
// cookie 內容：<到期秒數>.<HMAC-SHA256(到期秒數, APP_PASSWORD)> 的 base64url；改密碼即全部失效。
export const COOKIE = "ks_session";
export const SESSION_DAYS = 30;

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 沒設 APP_PASSWORD 就不啟用登入（本機開發） */
export const authEnabled = (env = process.env) => Boolean(env.APP_PASSWORD);

export async function issueSession(env = process.env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  return `${exp}.${await hmac(env.APP_PASSWORD, String(exp))}`;
}

export async function verifySession(token, env = process.env) {
  if (!authEnabled(env)) return true;
  if (!token) return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now() / 1000) return false;
  return timingSafeEqual(sig, await hmac(env.APP_PASSWORD, String(exp)));
}

export function checkPassword(input, env = process.env) {
  return timingSafeEqual(String(input || ""), String(env.APP_PASSWORD || ""));
}

/** 排程端點：Authorization: Bearer <CRON_SECRET> 或 x-cron-secret 標頭 */
export function verifyCron(headers, env = process.env) {
  if (!env.CRON_SECRET) return false;
  const h = (k) => headers.get ? headers.get(k) : headers[k];
  const bearer = (h("authorization") || "").replace(/^Bearer\s+/i, "");
  return timingSafeEqual(bearer, env.CRON_SECRET) || timingSafeEqual(h("x-cron-secret") || "", env.CRON_SECRET);
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { secure = true } = {}) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** 不需登入的路徑（登入頁本身與排程端點） */
export const PUBLIC_PATHS = new Set(["/login.html", "/api/login", "/api/cycle", "/favicon.svg", "/style.css"]);
