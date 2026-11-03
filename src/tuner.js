// 自動調參：在參數空間隨機搜尋，用回測挑出「報酬 - 0.5 × 最大回撤」最高的一組風控參數
import { runBacktest, loadHistories } from "./backtest.js";
import { DEFAULT_RISK } from "./strategy.js";

const SPACE = {
  buyThreshold: [2, 2.5, 3, 3.5, 4],
  sellThreshold: [-2, -2.5, -3, -3.5, -4],
  stopLossPct: [0.05, 0.08, 0.1, 0.12, 0.15, 0.2],
  takeProfitPct: [0.1, 0.15, 0.2, 0.25, 0.3, 0.4],
  perTradePct: [0.1, 0.15, 0.2, 0.25, 0.3],
  maxPositionPct: [0.2, 0.25, 0.3, 0.4],
  cooldownDays: [3, 5, 8, 10],
};
const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export async function tuneRisk({ symbols, cash = 1000000, days = 120, baseRisk = {}, fees, trials = 40, seed = 42, onProgress } = {}) {
  const histories = await loadHistories([...symbols, "0050"], 12);
  const rnd = mulberry32(seed);
  const candidates = [{ ...DEFAULT_RISK, ...baseRisk }]; // 先放目前參數當基準
  for (let i = 0; i < trials; i++) {
    const c = { ...DEFAULT_RISK, ...baseRisk };
    for (const [k, vals] of Object.entries(SPACE)) c[k] = pick(vals, rnd);
    candidates.push(c);
  }
  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const risk = candidates[i];
    const r = await runBacktest({ symbols, cash, days, risk, fees, histories });
    const fitness = r.returnPct - 0.5 * r.maxDrawdownPct - (r.trades < 3 ? 5 : 0);
    results.push({ risk, returnPct: r.returnPct, maxDrawdownPct: r.maxDrawdownPct, trades: r.trades, winRate: r.winRate, benchmarkReturnPct: r.benchmarkReturnPct, fitness: +fitness.toFixed(2), isCurrent: i === 0 });
    onProgress?.(i + 1, candidates.length);
  }
  results.sort((a, b) => b.fitness - a.fitness);
  return { best: results[0], current: results.find((x) => x.isCurrent), top: results.slice(0, 5), tried: results.length, days, symbols };
}
