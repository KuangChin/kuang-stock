// 交易引擎：抓報價 -> 指標 -> 新聞 -> 策略 -> (AI) -> 模擬成交 -> 記錄
import { getQuotes, getIndexQuotes, getDailyHistory, isMarketOpen, taipeiNow, getListing, getInstitutional, getMargin, getValuation, getRevenue } from "./twse.js";
import { getGlobalMarkets } from "./yahoo.js";
import { getTaifex } from "./taifex.js";
import { getAdvisorViews, getAdvisorViewsCached } from "./advisors.js";
import { computeIndicators } from "./indicators.js";
import { gatherNews, aggregateSentiment } from "./news.js";
import { decide } from "./strategy.js";
import { analyzeSymbol } from "./analysts/index.js";
import { analyzeMarket } from "./analysts/macro.js";
import { buildSummary } from "./summary.js";
import { executeOrder, valuation, accrueInterest, marginRatio } from "./portfolio.js";
import { getState, saveState, addLog } from "./store.js";
import { aiAvailable, aiDecide, writeSnapshot, readExternalDecisions } from "./analyst.js";
import { storage } from "./storage.js";

let running = null;
const histCache = new Map(); // symbol -> {t, bars}

async function historyFor(symbol) {
  const c = histCache.get(symbol);
  if (c && Date.now() - c.t < 30 * 60 * 1000) return c.bars;
  const bars = await getDailyHistory(symbol, { months: 7 });
  histCache.set(symbol, { t: Date.now(), bars });
  return bars;
}

/** 把今日即時報價併入日線（若日線尚未包含今天） */
function mergeToday(bars, q) {
  if (!q?.date || !q.price || !bars.length) return bars;
  const lastBar = bars[bars.length - 1];
  if (lastBar.date >= q.date) return bars;
  return [...bars, { date: q.date, open: q.open ?? q.price, high: q.high ?? q.price, low: q.low ?? q.price, close: q.price, volume: q.volume ?? 0, live: true }];
}

export async function analyzeSymbols(symbols, { withNews = true, advisorsCached = false } = {}) {
  const state = getState();
  const listing = await getListing();
  const quotes = await getQuotes(symbols);
  const indices = await getIndexQuotes().catch(() => ({}));
  const names = {};
  for (const s of symbols) names[s] = quotes[s]?.name || listing[s]?.name || s;
  const [news, global, taifex, insti, margin, valuation, revenue, advisors] = await Promise.all([
    withNews ? gatherNews(names) : { bySymbol: {}, macro: [] },
    getGlobalMarkets().catch(() => ({})),
    getTaifex().catch(() => null),
    getInstitutional(symbols, { days: 10 }).catch(() => ({})),
    getMargin(symbols).catch(() => ({})),
    getValuation(symbols).catch(() => ({})),
    getRevenue(symbols).catch(() => ({})),
    advisorsCached ? getAdvisorViewsCached(symbols).catch(() => null) : getAdvisorViews(symbols, names, state.config).catch((e) => { addLog("投顧觀點取得失敗：" + e.message, "warn"); return null; }),
  ]);
  const macroSent = aggregateSentiment(news.macro);
  const macro = analyzeMarket({ indices, global, taifex, macroSentiment: macroSent.score });
  const analyses = {};
  for (const s of symbols) {
    const q = quotes[s];
    let bars = await historyFor(s);
    bars = mergeToday(bars, q);
    const ind = computeIndicators(bars);
    const sent = aggregateSentiment(news.bySymbol[s] || []);
    const ctx = { symbol: s, name: names[s], ind, quote: q, news: news.bySymbol[s] || [], sentiment: sent, macroSentiment: macroSent.score, global, insti: insti[s] || [], margin: margin[s] || null, valuation: valuation[s] || null, revenue: revenue[s] || null, advisor: advisors?.bySymbol?.[s] || null, advisorMarket: advisors?.market || null };
    const r = analyzeSymbol(ctx, macro, state.config.weights);
    analyses[s] = { symbol: s, name: names[s], quote: q, price: q?.price ?? ind?.latest?.close ?? null, changePct: q?.changePct ?? null, indicators: ind?.latest || null, series: ind?.series || null, news: news.bySymbol[s] || [], sentiment: sent, score: r.score, reasons: r.reasons, analysts: r.breakdown, valuation: valuation[s] || null, revenue: revenue[s] || null };
  }
  return { quotes, indices, global, taifex, macro, analyses, macroNews: news.macro, macroSentiment: macroSent.score, advisors };
}

/** 融資計畫：每檔的成數（上市／上櫃）、追繳門檻與目前整戶維持率，交給 decide 與 executeOrder */
export async function marginPlan(state, symbols, val) {
  const cfg = state.config.margin || {};
  const ratio = {};
  if (cfg.enabled) {
    const listing = await getListing().catch(() => ({}));
    for (const s of symbols) ratio[s] = marginRatio(listing[s]?.market || "tse", cfg);
  }
  return { enabled: Boolean(cfg.enabled), ratio, maintenance: cfg.maintenance, forceSell: cfg.forceSell !== false, currentRatio: val.maintenance };
}

/**
 * 執行一輪。execute=true 才真的模擬成交；否則只產生建議。
 */
export async function runCycle({ execute = false, source = "manual" } = {}) {
  if (running) return running;
  running = (async () => {
    const state = getState();
    const t0 = Date.now();
    const symbols = [...new Set([...Object.keys(state.positions), ...state.config.watchlist])];
    const marketOpen = isMarketOpen();
    addLog(`開始分析 ${symbols.length} 檔（${marketOpen ? "盤中" : "盤後"}，來源 ${source}）`);
    const { quotes, indices, global, taifex, macro, analyses, macroNews, macroSentiment, advisors } = await analyzeSymbols(symbols);
    const interest = accrueInterest(state);
    if (interest) addLog(`融資利息累計 ${interest} 元`);
    const val = valuation(state, quotes);
    const lastBuyDays = {};
    for (const t of state.trades) if (t.side === "BUY" && lastBuyDays[t.symbol] == null) lastBuyDays[t.symbol] = Math.floor((Date.now() - new Date(t.t)) / 86400e3);
    const margin = await marginPlan(state, symbols, val);
    if (val.marginCall) addLog(`融資追繳：整戶維持率 ${val.maintenance}% 低於 ${val.maintenanceLine}%`, "warn");
    const ruleDecisions = decide({ analyses, positions: state.positions, cash: state.cash, totalEquity: val.total, risk: state.config.risk, lastBuyDays, margin });
    for (const d of ruleDecisions) if (analyses[d.symbol]) analyses[d.symbol].ruleDecision = d;

    // --- AI 分析師 ---
    let ai = null, aiError = null;
    const snapshot = {
      time: taipeiNow(), marketOpen, indices, global, taifex, macro, macroSentiment, macroNews, advisors, valuation: val, risk: state.config.risk, margin: state.config.margin, weights: state.config.weights, radar: state.radar ? { date: state.radar.date, items: state.radar.items } : null,
      analyses: Object.values(analyses).map(({ series, quote, ...rest }) => rest),
    };
    await writeSnapshot(snapshot).catch(() => {});
    const ext = await readExternalDecisions();
    if (ext) { ai = { ...ext, model: "external (Claude Code)" }; addLog("採用外部分析師決策 data/ai_decisions.json"); }
    else if (state.config.ai.enabled) {
      if (!aiAvailable()) aiError = "AI 已啟用但找不到 ANTHROPIC_API_KEY，改用規則引擎";
      else {
        try { ai = await aiDecide(snapshot, { model: state.config.ai.model, effort: state.config.ai.effort }); addLog(`AI 分析完成 (${ai.model})`); }
        catch (e) { aiError = `AI 分析失敗：${e.message}`; }
      }
      if (aiError) addLog(aiError, "warn");
    }

    // --- 合併決策：AI 存在時以 AI 為主，但仍受規則風控（停損一律執行） ---
    let finalDecisions = ruleDecisions;
    if (ai) {
      const byRule = Object.fromEntries(ruleDecisions.map((d) => [d.symbol, d]));
      finalDecisions = [];
      for (const d of ai.decisions) {
        const a = analyses[d.symbol]; if (!a || !a.price) continue;
        const rule = byRule[d.symbol];
        if (rule?.kind === "stop" || rule?.kind === "margincall") { finalDecisions.push({ ...rule, reason: rule.reason + "（規則強制）" }); continue; }
        if (d.action === "BUY") {
          const ratio = margin.enabled ? margin.ratio[d.symbol] || 0 : 0;
          const cashPart = state.cash * (d.size_pct / 100);
          const budget = Math.min(ratio ? cashPart / (1 - ratio) : cashPart, val.total * state.config.risk.maxPositionPct - (state.positions[d.symbol]?.shares || 0) * a.price);
          let shares = Math.floor(budget / (a.price * 1000)) * 1000;
          const onMargin = ratio > 0 && shares > 0;
          if (shares === 0 && state.config.risk.oddLot) shares = Math.floor(cashPart / a.price);
          finalDecisions.push({ symbol: d.symbol, action: shares > 0 ? "BUY" : "HOLD", shares: Math.max(shares, 0), margin: onMargin, reason: `AI：${d.reason} (信心 ${d.confidence})${onMargin ? `，融資 ${Math.round(ratio * 100)}%` : ""}`, score: a.score, kind: "ai", confidence: d.confidence });
        } else if (d.action === "SELL") {
          const held = state.positions[d.symbol]?.shares || 0;
          const shares = Math.floor(held * (d.size_pct / 100));
          finalDecisions.push({ symbol: d.symbol, action: shares > 0 ? "SELL" : "HOLD", shares, reason: `AI：${d.reason} (信心 ${d.confidence})`, score: a.score, kind: "ai", confidence: d.confidence });
        } else finalDecisions.push({ symbol: d.symbol, action: "HOLD", shares: 0, reason: `AI：${d.reason}`, score: a.score, kind: "ai", confidence: d.confidence });
      }
      for (const r of ruleDecisions) if (!finalDecisions.find((d) => d.symbol === r.symbol)) finalDecisions.push(r);
    }

    // --- 模擬成交 ---
    const executed = [];
    if (execute) {
      for (const d of finalDecisions) {
        if (d.action === "HOLD" || !(d.shares > 0)) continue;
        const a = analyses[d.symbol];
        const q = a.quote;
        const price = d.action === "BUY" ? q?.bestAsk || a.price : q?.bestBid || a.price;
        const r = executeOrder(state, { symbol: d.symbol, side: d.action, shares: d.shares, price, name: a.name, reason: d.reason, source: ai ? "ai" : "rule", margin: Boolean(d.margin), ratio: margin.ratio[d.symbol] || 0 });
        if (r.error) { addLog(`${d.symbol} ${d.action} 失敗：${r.error}`, "warn"); d.result = r.error; }
        else { executed.push(r.trade); d.result = "成交"; addLog(`${d.action} ${d.symbol} ${a.name} ${d.shares} 股 @ ${price}：${d.reason}`); }
      }
    }
    const val2 = valuation(state, quotes);
    const summary = buildSummary({ analyses, macro, decisions: finalDecisions, ai, valuation: val2, risk: state.config.risk, marketOpen, advisors });
    state.equity.push({ t: new Date().toISOString(), total: val2.total, cash: val2.cash, marketValue: val2.marketValue });
    if (state.equity.length > 5000) state.equity.splice(0, state.equity.length - 5000);
    state.lastCycle = {
      t: new Date().toISOString(), tTaipei: taipeiNow(), marketOpen, executed: execute, source, durationMs: Date.now() - t0,
      indices, global, taifex, macro, macroNews: macroNews.slice(0, 20), macroSentiment, advisors, ai: ai ? { market_view: ai.market_view, risk_level: ai.risk_level, model: ai.model, usage: ai.usage, discussion: ai.discussion || null, action_plan: ai.action_plan || null } : null, aiError, summary,
      decisions: finalDecisions,
      analyses: Object.fromEntries(Object.values(analyses).map((a) => [a.symbol, { symbol: a.symbol, name: a.name, price: a.price, changePct: a.changePct, quote: a.quote && { bestAsk: a.quote.bestAsk, bestBid: a.quote.bestBid, volume: a.quote.volume, time: a.quote.time, high: a.quote.high, low: a.quote.low, open: a.quote.open, prevClose: a.quote.prevClose }, indicators: a.indicators, score: a.score, reasons: a.reasons, analysts: a.analysts, sentiment: a.sentiment, valuation: a.valuation || null, revenue: a.revenue ? { month: a.revenue.month, yoy: a.revenue.yoy, mom: a.revenue.mom } : null, news: a.news.slice(0, 8) }])),
      valuation: val2, trades: executed,
    };
    await saveState(["cash", "positions", "trades", "equity", "lastCycle", "log"]);
    return state.lastCycle;
  })().finally(() => { running = null; });
  return running;
}

export async function symbolDetail(symbol) {
  const { analyses, indices, macro, global, taifex, advisors } = await analyzeSymbols([symbol], { advisorsCached: true });
  const a = analyses[symbol];
  return { ...a, indices, macro, global, taifex, advisors };
}

// ---------- 自動排程 ----------
const taipeiDate = (d = new Date()) => new Date(d.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
const ymd = (tw) => `${tw.getFullYear()}-${String(tw.getMonth() + 1).padStart(2, "0")}-${String(tw.getDate()).padStart(2, "0")}`;

/**
 * 自動輪次的共用判斷：本機 setInterval 與雲端 POST /api/cycle（排程呼叫）都走這裡。
 * - 盤中：每 intervalMin 分鐘跑一輪（雲端由排程間隔決定，這裡只檢查 lastAutoRun）
 * - 收盤後（13:35 起）：一天只跑一次，記在 state.lastAutoClose；Redis 模式再加 NX 鎖防止排程重複觸發
 * 回傳 { ran, reason, cycle? }
 */
export async function autoTick({ wait = false } = {}) {
  const state = getState();
  const cfg = state.config.auto;
  if (!cfg.enabled) return { ran: false, reason: "自動執行已關閉" };
  if (running) return { ran: false, reason: "上一輪尚在執行" };
  const tw = taipeiDate();
  const today = ymd(tw);
  const open = isMarketOpen();
  const mins = tw.getHours() * 60 + tw.getMinutes();
  const weekday = tw.getDay() >= 1 && tw.getDay() <= 5;
  const afterClose = weekday && mins >= 13 * 60 + 35;

  if (open) {
    const last = state.lastAutoRun ? new Date(state.lastAutoRun).getTime() : 0;
    if (Date.now() - last < cfg.intervalMin * 60 * 1000 - 15 * 1000) return { ran: false, reason: `距上次自動輪次未滿 ${cfg.intervalMin} 分鐘` };
    if (!(await storage.lock("cycle", 240))) return { ran: false, reason: "另一個實例正在執行" };
    state.lastAutoRun = new Date().toISOString();
    await saveState(["lastAutoRun", "log"]);
    const p = runCycle({ execute: true, source: "auto" }).catch((e) => addLog("自動輪次失敗：" + e.message, "error")).finally(() => storage.unlock("cycle").catch(() => {}));
    return { ran: true, reason: "盤中自動輪次", cycle: wait ? await p : undefined };
  }
  if (cfg.executeOnClose && afterClose) {
    if (state.lastAutoClose === today) return { ran: false, reason: `今日 (${today}) 收盤輪次已執行` };
    if (!(await storage.lock(`close:${today}`, 6 * 3600))) return { ran: false, reason: "收盤輪次已由其他實例執行" };
    // 先記錄再執行：伺服器重啟或排程補跑都不會重複
    state.lastAutoClose = today;
    await saveState(["lastAutoClose", "log"]);
    const p = runCycle({ execute: true, source: "auto-close" }).catch((e) => addLog("收盤輪次失敗：" + e.message, "error"));
    return { ran: true, reason: "收盤輪次", cycle: wait ? await p : undefined };
  }
  return { ran: false, reason: open ? "盤中" : afterClose ? "收盤輪次已關閉" : "非交易時段" };
}

let timer = null;
export function startScheduler() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => autoTick().catch((e) => console.error("[scheduler]", e)), 20 * 1000);
}
