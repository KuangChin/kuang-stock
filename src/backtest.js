// 歷史回測：只用技術線型分析師在日線上逐日模擬（以次日開盤價成交；籌碼、基本面、新聞無歷史快照故不納入）
import { getDailyHistory } from "./twse.js";
import { computeIndicators } from "./indicators.js";
import { decide, DEFAULT_RISK } from "./strategy.js";
import { combine } from "./analysts/index.js";
import * as technical from "./analysts/technical.js";
import { executeOrder, valuation } from "./portfolio.js";

export async function loadHistories(symbols, months = 12) {
  const histories = {};
  for (const s of [...new Set(symbols)]) histories[s] = await getDailyHistory(s, { months });
  return histories;
}

export async function runBacktest({ symbols, cash = 1000000, days = 120, risk = {}, fees, benchmark = "0050", months = 12, histories = null }) {
  symbols = [...new Set(symbols.map(String))];
  risk = { ...DEFAULT_RISK, ...risk };
  if (!histories) histories = await loadHistories([...symbols, benchmark], months);
  const dates = [...new Set(Object.values(histories).flat().map((b) => b.date))].sort();
  const warm = 65;
  const startIdx = Math.max(warm, dates.length - days);
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
    symbols, days: curve.length, start: curve[0]?.date, end: curve[curve.length - 1]?.date,
    initialCash: cash, finalEquity: final, returnPct: +(((final - cash) / cash) * 100).toFixed(2),
    benchmarkReturnPct: benchFinal ? +(((benchFinal - cash) / cash) * 100).toFixed(2) : null, benchmark,
    maxDrawdownPct: +(maxDD * 100).toFixed(2), trades: state.trades.length, sells: sells.length, winRate: sells.length ? +((wins / sells.length) * 100).toFixed(1) : null,
    realized: Math.round(state.trades.reduce((s, t) => s + (t.realized || 0), 0)),
    curve, tradeLog: [...state.trades].reverse(), positions: state.positions,
  };
}
