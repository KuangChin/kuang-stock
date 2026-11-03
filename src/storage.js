// 儲存層 adapter：有 Upstash Redis 環境變數時走 Redis REST，否則寫本機 data/ 目錄。
// Redis 模式用於 Vercel（無持久磁碟）；檔案模式用於本機開發，行為與舊版相同。
import fs from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "./env.js";

loadEnv();

const DATA_DIR = path.resolve("data");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const PREFIX = process.env.KS_PREFIX || "ks";

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

export const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
export const backend = redisConfig() ? "redis" : "file";

// ---------- Redis REST（Upstash），不另外裝套件 ----------
async function redis(cmd) {
  const { url, token } = redisConfig();
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (j.error) throw new Error(`Redis: ${j.error}`);
  return j.result;
}

const redisAdapter = {
  name: "redis",
  async get(key) {
    const v = await redis(["GET", `${PREFIX}:${key}`]);
    return v == null ? null : JSON.parse(v);
  },
  async set(key, value, { ttlSec } = {}) {
    const cmd = ["SET", `${PREFIX}:${key}`, JSON.stringify(value)];
    if (ttlSec) cmd.push("EX", String(ttlSec));
    await redis(cmd);
  },
  async del(key) { await redis(["DEL", `${PREFIX}:${key}`]); },
  /** 取鎖：成功回 true。用於 serverless 防止同一輪次重複執行 */
  async lock(key, ttlSec) {
    const r = await redis(["SET", `${PREFIX}:lock:${key}`, String(Date.now()), "NX", "EX", String(ttlSec)]);
    return r === "OK";
  },
  async unlock(key) { await redis(["DEL", `${PREFIX}:lock:${key}`]); },
  // 快取：存 {t, v}，讀取時依 maxAgeMs 判斷；Redis 本身設 30 天過期避免無限成長
  async cacheGet(key, maxAgeMs) {
    const w = await this.get(`cache:${key}`);
    if (!w) return null;
    if (maxAgeMs != null && Date.now() - w.t > maxAgeMs) return null;
    return w.v;
  },
  async cacheSet(key, value) { await this.set(`cache:${key}`, { t: Date.now(), v: value }, { ttlSec: 30 * 86400 }); },
};

// ---------- 本機檔案 ----------
let writing = Promise.resolve();
async function atomicWrite(file, text) {
  writing = writing.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  });
  return writing;
}
const fileAdapter = {
  name: "file",
  async get(key) {
    try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, key + ".json"), "utf8")); } catch { return null; }
  },
  async set(key, value) { await atomicWrite(path.join(DATA_DIR, key + ".json"), JSON.stringify(value, null, 1)); },
  async del(key) { await fs.rm(path.join(DATA_DIR, key + ".json"), { force: true }); },
  async lock() { return true; },
  async unlock() {},
  async cacheGet(key, maxAgeMs) {
    try {
      const p = path.join(CACHE_DIR, key + ".json");
      const st = await fs.stat(p);
      if (maxAgeMs != null && Date.now() - st.mtimeMs > maxAgeMs) return null;
      return JSON.parse(await fs.readFile(p, "utf8"));
    } catch { return null; }
  },
  async cacheSet(key, value) {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, key + ".json"), JSON.stringify(value));
  },
};

export const storage = backend === "redis" ? redisAdapter : fileAdapter;
