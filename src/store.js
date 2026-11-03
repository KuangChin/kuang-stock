import { DEFAULT_RISK } from "./strategy.js";
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

let state = null;

export function mergeDefaults(loaded) {
  const d = defaultState();
  const c = loaded.config || {};
  loaded.config = { ...d.config, ...c, fees: { ...d.config.fees, ...c.fees }, risk: { ...d.config.risk, ...c.risk }, weights: { ...d.config.weights, ...c.weights }, auto: { ...d.config.auto, ...c.auto }, ai: { ...d.config.ai, ...c.ai } };
  return loaded;
}

/**
 * 載入狀態。本機（單一程序）載入一次後留在記憶體；
 * Redis 模式每個請求都要 fresh 重讀，因為排程與頁面可能在不同的 function 實例上寫入。
 */
export async function loadState({ fresh = false } = {}) {
  if (state && !fresh) return state;
  const loaded = await storage.get(KEY);
  if (loaded) state = mergeDefaults(loaded);
  else { state = defaultState(); await saveState(); }
  return state;
}

/**
 * 儲存。fields 給了就只寫這些欄位：先讀回儲存層的最新版，覆蓋指定欄位再存回，
 * 避免雲端上同時進行的請求（例如對話與分析）互相把對方的結果蓋掉。
 * 本機檔案模式是單一程序，直接整份寫。
 */
export async function saveState(fields = null) {
  if (!fields || storage.name === "file") { await storage.set(KEY, state); return; }
  const cur = await storage.get(KEY);
  if (!cur) { await storage.set(KEY, state); return; }
  for (const f of fields) cur[f] = state[f];
  // 其他欄位以儲存層為準，同步回記憶體，讓這個請求後續讀到的也是最新的
  for (const k of Object.keys(cur)) if (!fields.includes(k)) state[k] = cur[k];
  await storage.set(KEY, cur);
}

export function getState() {
  return state;
}

export async function resetState(partial = {}) {
  const d = defaultState();
  const keepConfig = state?.config || d.config;
  state = { ...d, config: { ...keepConfig, ...(partial.config || {}) } };
  if (partial.cash != null) { state.cash = partial.cash; state.config.initialCash = partial.cash; }
  let costBasis = 0;
  if (partial.positions) {
    for (const p of partial.positions) {
      if (!p.symbol || !p.shares) continue;
      state.positions[String(p.symbol)] = { shares: Number(p.shares), avgCost: Number(p.avgCost || 0), name: p.name || "" };
      costBasis += Number(p.shares) * Number(p.avgCost || 0);
    }
  }
  // 報酬基準 = 起始現金 + 原始持股成本
  state.initialEquity = state.cash + costBasis;
  await saveState();
  return state;
}

export function addLog(msg, level = "info") {
  if (!state) return;
  state.log.unshift({ t: new Date().toISOString(), level, msg });
  if (state.log.length > 300) state.log.length = 300;
}
