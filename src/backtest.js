// 歷史回測：只用技術線型分析師在日線上逐日模擬（以次日開盤價成交；籌碼、基本面、新聞無歷史快照故不納入）
import { getDailyHistory } from "./twse.js";
import { computeIndicators } from "./indicators.js";
import { decide, DEFAULT_RISK } from "./strategy.js";
import { combine } from "./analysts/index.js";
import * as technical from "./analysts/technical.js";
import { executeOrder, valuation } from "./portfolio.js";

const WARM = 65; // 指標暖機需要的交易日數
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 把 from 往前推 4 個月當暖機資料的起點 */
function warmFrom(from) {
  const d = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1 - 4, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * 還原股票分割：證交所歷史價是原始價，像 0050 在 2025-06-18 一拆四，跨過那天的回測會被當成大跌。
 * 相鄰兩根 K 棒收盤價比值超過 1.6 倍（或低於 0.6）視為分割，把之前的價格除以整數倍數、成交量乘回去。
 */
export function adjustSplits(bars) {
  const out = bars.map((b) => ({ ...b }));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1], cur = out[i];
    if (!prev.close || !cur.open) continue;
    const ratio = prev.close / cur.open;
    let factor = null;
    if (ratio > 1.6) factor = Math.round(ratio);
    else if (ratio < 0.6) factor = 1 / Math.round(1 / ratio);
    if (!factor || factor === 1) continue;
    for (let k = 0; k < i; k++) {
      const b = out[k];
      for (const f of ["open", "high", "low", "close"]) if (b[f] != null) b[f] = +(b[f] / factor).toFixed(2);
      if (b.volume != null) b.volume = Math.round(b.volume * factor);
    }
  }
  return out;
}

export async function loadHistories(symbols, opts = 12) {
  const o = typeof opts === "number" ? { months: opts } : opts;
  const histories = {};
  for (const s of [...new Set(symbols)]) histories[s] = adjustSplits(await getDailyHistory(s, { months: o.months ?? 12, from: o.from ? warmFrom(o.from) : null, to: o.to || null }));
  return histories;
}

/** 正規化時間段：from/to 要是 YYYY-MM-DD，且 from <= to；不合格就當沒給 */
export function normalizeRange({ from, to } = {}) {
  from = ISO_DATE.test(from || "") ? from : null;
  to = ISO_DATE.test(to || "") ? to : null;
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to };
}

/**
 * 回測時間段兩種給法：days（最近 N 個交易日，預設）或 from/to（指定起迄日期，含暖機自動往前抓資料）。
 * maxDays 是雲端上限：不論哪種給法，最多只跑這麼多個交易日（從 to 往前算）。
 */
export async function runBacktest({ symbols, cash = 1000000, days = 120, from = null, to = null, maxDays = null, risk = {}, fees, benchmark = "0050", months = 12, histories = null }) {
  symbols = [...new Set(symbols.map(String))];
  risk = { ...DEFAULT_RISK, ...risk };
  ({ from, to } = normalizeRange({ from, to }));
  if (!histories) histories = await loadHistories([...symbols, benchmark], from ? { from, to } : { months: to ? Math.ceil((days + WARM) / 21) + 1 : months, to });
  let dates = [...new Set(Object.values(histories).flat().map((b) => b.date))].sort();
  if (to) dates = dates.filter((d) => d <= to);
  const warm = WARM;
  const fromIdx = from ? dates.findIndex((d) => d >= from) : -1;
  let startIdx = from ? (fromIdx < 0 ? dates.length : Math.max(warm, fromIdx)) : Math.max(warm, dates.length - days);
  if (maxDays) startIdx = Math.max(startIdx, dates.length - maxDays);
  if (startIdx >= dates.length) return { symbols, days: 0, start: null, end: null, from, to, initialCash: cash, finalEquity: cash, returnPct: 0, benchmarkReturnPct: null, benchmark, maxDrawdownPct: 0, trades: 0, sells: 0, winRate: null, realized: 0, curve: [], tradeLog: [], positions: {}, error: "指定時間段內沒有足夠的歷史資料（需要 65 個交易日暖機）" };
  const state = {
    config: { initialCash: cash, fees: { commission: 0.001425, minFee: 20, tax: 0.003, discount: 0.6, ...(fees || {}) }, risk },
    cash, positions: {}, trades: [], equity: [],
  };
  const byDate = {};
  for (const s of Object.keys(histories)) { byDate[s] = {}; histories[s].forEach((b, i) => (byDate[s][b.date] = i)); }
  let pending = [];
  const curve = [];
  const bench0 = histories[benchmark]?.find((b) => b.date >= dates[startIdx])?.close;
  for (let di = startIdx; di < dates.length; di++) {
    const date = dates[di];
    // 1. 先以今日開盤價成交昨日決策
    for (const d of pending) {
      const bi = byDate[d.symbol][date]; if (bi == null) continue;
      const bar = histories[d.symbol][bi];
      const r = executeOrder(state, { symbol: d.symbol, side: d.action, shares: d.shares, price: bar.open, reason: d.reason, source: "backtest" });
      if (r.trade) r.trade.t = date;
    }
    pending = [];
    // 2. 用今日收盤算指標與決策
    const analyses = {}, quotes = {};
    for (const s of symbols) {
      const bi = byDate[s][date]; if (bi == null || bi < warm) continue;
      const bars = histories[s].slice(0, bi + 1);
      const ind = computeIndicators(bars);
      const bar = bars[bars.length - 1], prev = bars[bars.length - 2];
      const quote = { price: bar.close, changePct: prev ? +(((bar.close - prev.close) / prev.close) * 100).toFixed(2) : 0 };
      quotes[s] = quote;
      const sc = combine({ technical: technical.analyze({ ind, quote }) });
      analyses[s] = { price: bar.close, score: sc.score, reasons: sc.reasons };
    }
    const val = valuation(state, quotes);
    const lastBuyDays = {};
    for (const t of state.trades) if (t.side === "BUY" && lastBuyDays[t.symbol] == null) lastBuyDays[t.symbol] = Math.round((new Date(date) - new Date(t.t)) / 86400e3);
    const decisions = decide({ analyses, positions: state.positions, cash: state.cash, totalEquity: val.total, risk, lastBuyDays });
    pending = decisions.filter((d) => d.action !== "HOLD" && d.shares > 0);
    const bb = histories[benchmark]?.[byDate[benchmark][date]];
    curve.push({ date, total: val.total, cash: val.cash, benchmark: bb && bench0 ? +((bb.close / bench0) * cash).toFixed(0) : null });
  }
  // 統計
  let peak = -Infinity, maxDD = 0;
  for (const p of curve) { peak = Math.max(peak, p.total); maxDD = Math.max(maxDD, (peak - p.total) / peak); }
  const sells = state.trades.filter((t) => t.side === "SELL");
  const wins = sells.filter((t) => t.realized > 0).length;
  const final = curve[curve.length - 1]?.total ?? cash;
  const benchFinal = curve[curve.length - 1]?.benchmark;
  return {
    symbols, days: curve.length, start: curve[0]?.date, end: curve[curve.length - 1]?.date, from, to,
    truncated: !!(maxDays && from && dates[startIdx] > from) || undefined,
    initialCash: cash, finalEquity: final, returnPct: +(((final - cash) / cash) * 100).toFixed(2),
    benchmarkReturnPct: benchFinal ? +(((benchFinal - cash) / cash) * 100).toFixed(2) : null, benchmark,
    maxDrawdownPct: +(maxDD * 100).toFixed(2), trades: state.trades.length, sells: sells.length, winRate: sells.length ? +((wins / sells.length) * 100).toFixed(1) : null,
    realized: Math.round(state.trades.reduce((s, t) => s + (t.realized || 0), 0)),
    curve, tradeLog: [...state.trades].reverse(), positions: state.positions,
  };
}
