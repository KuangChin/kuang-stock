import { DEFAULT_RISK } from "./strategy.js";
import { DEFAULT_MARGIN } from "./portfolio.js";
import { DEFAULT_WEIGHTS } from "./analysts/index.js";
import { storage } from "./storage.js";

const KEY = "state"; // 檔案模式 -> data/state.json；Redis 模式 -> ks:state

export function defaultState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    config: {
      initialCash: 1000000,
      fees: { commission: 0.001425, minFee: 20, tax: 0.003, discount: 0.6 },
      risk: { ...DEFAULT_RISK },
      margin: { ...DEFAULT_MARGIN }, // 融資：成數、利率、維持率
      weights: { ...DEFAULT_WEIGHTS },
      auto: { enabled: false, intervalMin: 5, executeOnClose: true },
      watchlist: ["2330", "2317", "2454", "0050", "2603", "2881"],
      ai: { enabled: false, model: "claude-opus-5-5", effort: "medium", mode: "advise" },
    },
    cash: 1000000,
    initialEquity: 1000000,
    positions: {}, // symbol -> {shares, avgCost, name}
    trades: [],    // {t, symbol, name, side, shares, price, fee, tax, amount, reason, source}
    equity: [],    // {t, total, cash, marketValue}
    lastCycle: null,
    log: [],
  };
}

// 狀態物件：
// - 本機（單一程序）：載入一次放在 moduleState，所有請求與排程共用。
// - 雲端（每個請求都從 Redis 重讀）：每個請求有自己的一份，放在 AsyncLocalStorage 裡。
//   以前用單一 module 變數，頁面每分鐘輪詢 /api/state 時會把「正在分析中」的那份整個換掉，
//   分析完存檔時拿到的是輪詢載入的舊物件，結果永遠寫不進去。
import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage();
let moduleState = null;
const current = () => als.getStore()?.state ?? moduleState;

export function mergeDefaults(loaded) {
  const d = defaultState();
  const c = loaded.config || {};
  loaded.config = { ...d.config, ...c, fees: { ...d.config.fees, ...c.fees }, risk: { ...d.config.risk, ...c.risk }, margin: { ...d.config.margin, ...c.margin }, weights: { ...d.config.weights, ...c.weights }, auto: { ...d.config.auto, ...c.auto }, ai: { ...d.config.ai, ...c.ai } };
  return loaded;
}

/**
 * 載入狀態。fresh=false：有就直接用（本機）。fresh=true：從儲存層重讀一份新的，
 * 不會動到其他請求正在用的物件；呼叫端要用 runWithState() 把它綁到這個請求。
 */
export async function loadState({ fresh = false } = {}) {
  if (!fresh && current()) return current();
  const loaded = await storage.get(KEY);
  let st;
  if (loaded) st = mergeDefaults(loaded);
  else { st = defaultState(); await storage.set(KEY, st); }
  if (!moduleState) moduleState = st;
  return st;
}
/** 在 fn 執行期間（含其中所有 await / 背景 promise）getState() 都回傳 st */
export function runWithState(st, fn) { return als.run({ state: st }, fn); }
/** 在目前的非同步流程中切換到 st（給 async generator 用：它的本體是在 handleApi 回傳後才執行） */
export function enterState(st) { als.enterWith({ state: st }); }

/**
 * 儲存。fields 給了就只寫這些欄位：先讀回儲存層的最新版，覆蓋指定欄位再存回，
 * 避免雲端上同時進行的請求（例如對話與分析）互相把對方的結果蓋掉。
 * 本機檔案模式是單一程序，直接整份寫。
 */
export async function saveState(fields = null, st = current()) {
  if (!st) return;
  if (!fields || storage.name === "file") { await storage.set(KEY, st); return; }
  const cur = await storage.get(KEY);
  if (!cur) { await storage.set(KEY, st); return; }
  for (const f of fields) cur[f] = st[f];
  for (const k of Object.keys(cur)) if (!fields.includes(k)) st[k] = cur[k];
  await storage.set(KEY, cur);
}

export function getState() {
  return current();
}

export async function resetState(partial = {}) {
  const st = current();
  const d = defaultState();
  const keepConfig = st?.config || d.config;
  const next = { ...d, config: { ...keepConfig, ...(partial.config || {}) } };
  if (partial.cash != null) { next.cash = partial.cash; next.config.initialCash = partial.cash; }
  let costBasis = 0;
  if (partial.positions) {
    for (const p of partial.positions) {
      if (!p.symbol || !p.shares) continue;
      next.positions[String(p.symbol)] = { shares: Number(p.shares), avgCost: Number(p.avgCost || 0), name: p.name || "", ...(p.loan > 0 ? { loan: Math.round(Number(p.loan)), interest: 0, interestAt: Date.now() } : {}) };
      costBasis += Number(p.shares) * Number(p.avgCost || 0);
    }
  }
  // 報酬基準 = 起始現金 + 原始持股成本
  next.initialEquity = next.cash + costBasis - Object.values(next.positions).reduce((t, p) => t + (p.loan || 0), 0);
  // 就地覆蓋，讓這個請求（與本機的排程）手上的參考都看到新內容
  if (st) { for (const k of Object.keys(st)) delete st[k]; Object.assign(st, next); } else moduleState = next;
  await saveState();
  return current();
}

export function addLog(msg, level = "info") {
  const st = current();
  if (!st) return;
  st.log.unshift({ t: new Date().toISOString(), level, msg });
  if (st.log.length > 300) st.log.length = 300;
}
