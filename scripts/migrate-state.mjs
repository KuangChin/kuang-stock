// 一次性：把本機 data/state.json 匯入 Redis（Upstash）。
// 用法：node scripts/migrate-state.mjs [--dry] [--stop-loss 0.3] [--auto on|off] [--force]
// 需要 .env 或環境變數提供 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（或 KV_REST_API_URL / KV_REST_API_TOKEN）。
import fs from "node:fs/promises";
import { loadEnv } from "../src/env.js";
loadEnv();
const { storage, backend } = await import("../src/storage.js");
const { mergeDefaults } = await import("../src/store.js");

const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
if (backend !== "redis") { console.error("找不到 Redis 環境變數（UPSTASH_REDIS_REST_URL / _TOKEN），無法匯入。"); process.exit(1); }

const local = mergeDefaults(JSON.parse(await fs.readFile("data/state.json", "utf8")));
if (flag("--stop-loss")) local.config.risk.stopLossPct = Number(flag("--stop-loss"));
if (flag("--auto")) local.config.auto.enabled = flag("--auto") === "on";
delete local.lastAutoRun;

const summary = { cash: local.cash, initialEquity: local.initialEquity, positions: local.positions, stopLossPct: local.config.risk.stopLossPct, auto: local.config.auto, ai: local.config.ai.enabled, trades: local.trades.length, equityPoints: local.equity.length, lastAutoClose: local.lastAutoClose };
console.log("將匯入的狀態：", JSON.stringify(summary, null, 1));

const existing = await storage.get("state");
if (existing && !args.includes("--force")) {
  console.error(`Redis 已有狀態（現金 ${existing.cash}，持股 ${Object.keys(existing.positions || {}).join(",") || "無"}）。要覆蓋請加 --force。`);
  process.exit(2);
}
if (args.includes("--dry")) { console.log("--dry：未寫入。"); process.exit(0); }
await storage.set("state", local);
const back = await storage.get("state");
console.log(back && back.cash === local.cash ? "匯入完成，Redis 讀回驗證成功。" : "匯入後讀回不一致，請檢查。");
