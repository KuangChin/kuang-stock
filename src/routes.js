// 共用路由表：本機 http 伺服器與 Vercel function 都用同一份。
// handleApi() 負責登入驗證、排程驗證、狀態載入與錯誤處理，回傳 { status, headers, body }。
import { loadState, getState, saveState, resetState, addLog, runWithState, enterState } from "./store.js";
import { runCycle, symbolDetail, autoTick } from "./engine.js";
import { runBacktest, normalizeRange } from "./backtest.js";
import { runRadar } from "./radar.js";
import { tuneRisk } from "./tuner.js";
import { getQuotes, getIndexQuotes, searchStocks, isMarketOpen, taipeiNow, getListing, getValuation } from "./twse.js";
import { executeOrder, valuation, marginRatio } from "./portfolio.js";
import { aiAvailable } from "./analyst.js";
import { chatStream, CHAT_MAX } from "./chat.js";
import { getTaifex } from "./taifex.js";
import { getGlobalMarkets } from "./yahoo.js";
import { getAdvisorItems, putTranscript, putSourceItems } from "./advisors.js";
import { storage, isServerless, backend } from "./storage.js";
import { authEnabled, verifySession, verifyCron, checkPassword, issueSession, sessionCookie, clearCookie, parseCookies, COOKIE } from "./auth.js";

// 雲端上的回測／調參規模上限（完整規模請在本機用 npm run backtest）
const CLOUD_LIMITS = { backtestSymbols: 10, backtestDays: 250, tuneTrials: 8 };

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function publicState() {
  const s = getState();
  return {
    config: s.config, cash: s.cash, initialEquity: s.initialEquity ?? s.config.initialCash, positions: s.positions,
    trades: s.trades.slice(0, 200), equity: s.equity.slice(-2000), lastCycle: s.lastCycle, radar: s.radar || null, log: s.log.slice(0, 100),
    marketOpen: isMarketOpen(), now: taipeiNow(), aiAvailable: aiAvailable(),
    runtime: { serverless: isServerless, backend, auth: authEnabled(), cloudLimits: isServerless ? CLOUD_LIMITS : null },
  };
}

/** 路由 handler 簽章：(url, body, ctx) -> 回傳資料（200）或 throw HttpError */
export const routes = {
  "GET /api/state": async () => publicState(),
  "GET /api/quotes": async (u) => { const syms = (u.searchParams.get("symbols") || "").split(",").filter(Boolean); return { quotes: await getQuotes(syms), indices: await getIndexQuotes() }; },
  "GET /api/search": async (u) => searchStocks(u.searchParams.get("q"), 12),
  "GET /api/symbol": async (u) => symbolDetail(u.searchParams.get("code")),
  // 側欄即時報價：臺指期（45 秒快取）與美股／國際市場（1 分鐘快取），不綁在分析快照上
  // 投顧來源最近集數（不含 Claude 整理）；本機腳本用它決定要抓哪些字幕
  "GET /api/advisors/items": async () => ({ items: await getAdvisorItems(getState().config) }),
  // 本機 npm run advisors-push 把 yt-dlp 抓到的字幕推上雲端（需要 CRON_SECRET）
  "POST /api/advisors/transcripts": async (u, body, ctx) => {
    if (!ctx.cron) throw new HttpError(403, "需要排程密鑰");
    const list = Array.isArray(body.transcripts) ? body.transcripts : [];
    let n = 0;
    for (const t of list) if (/^[\w-]{6,20}$/.test(t.videoId || "")) { await putTranscript(t.videoId, t.text); n++; }
    const sources = Array.isArray(body.items) && body.items.length ? await putSourceItems(body.items, getState().config) : [];
    await storage.cacheSet("advisors:lastPush", { t: taipeiNow(), stored: n, items: (body.items || []).length, sources, videos: list.map((t) => t.videoId).slice(0, 20), report: body.report || null }).catch(() => {});
    return { ok: true, stored: n, sources };
  },
  "GET /api/live": async () => {
    const s = getState();
    const syms = Object.keys(s.positions);
    const [taifex, global, quotes, indices] = await Promise.all([getTaifex().catch(() => null), getGlobalMarkets().catch(() => ({})), syms.length ? getQuotes(syms).catch(() => null) : null, getIndexQuotes().catch(() => null)]);
    // 持股用證交所即時報價重算市值與損益（不存檔，只給頁面顯示）
    const val = quotes ? valuation(s, quotes) : null;
    return { t: taipeiNow(), taifex, global, indices, valuation: val };
  },
  "POST /api/config": async (u, body) => {
    const s = getState();
    const c = s.config;
    if (body.risk) c.risk = { ...c.risk, ...body.risk };
    if (body.margin) c.margin = { ...c.margin, ...body.margin };
    if (body.radar) c.radar = { ...c.radar, ...body.radar };
    if (body.weights) c.weights = { ...c.weights, ...body.weights };
    if (body.auto) c.auto = { ...c.auto, ...body.auto };
    if (body.ai) c.ai = { ...c.ai, ...body.ai };
    if (body.fees) c.fees = { ...c.fees, ...body.fees };
    if (Array.isArray(body.watchlist)) c.watchlist = [...new Set(body.watchlist.map(String).filter((x) => /^\d{4,6}$/.test(x)))];
    addLog("設定已更新");
    await saveState(["config", "log"]);
    return publicState();
  },
  "POST /api/portfolio/reset": async (u, body) => { await resetState(body); addLog(`帳戶重設：現金 ${body.cash}，持股 ${(body.positions || []).length} 檔`); return publicState(); },
  "POST /api/order": async (u, body) => {
    const s = getState();
    const q = (await getQuotes([body.symbol]))[body.symbol];
    const price = body.price || (body.side === "BUY" ? q?.bestAsk : q?.bestBid) || q?.price;
    if (!price) throw new HttpError(400, "取不到報價");
    const useMargin = body.side === "BUY" && Boolean(body.margin);
    const ratio = useMargin ? marginRatio((await getListing().catch(() => ({})))[body.symbol]?.market || "tse", s.config.margin) : 0;
    const r = executeOrder(s, { symbol: body.symbol, side: body.side, shares: body.shares, price, name: q?.name, reason: body.reason || (useMargin ? "手動融資買進" : "手動下單"), source: "manual", margin: useMargin, ratio });
    if (r.error) throw new HttpError(400, r.error);
    addLog(`手動 ${body.side} ${body.symbol} ${body.shares} 股 @ ${price}${r.trade.loan ? `（融資 ${r.trade.loan}）` : ""}`);
    await saveState(["cash", "positions", "trades", "log"]);
    return { trade: r.trade, state: publicState() };
  },
  /**
   * 兩種呼叫方式：
   * - 已登入的使用者（頁面按鈕）：手動輪次，body.execute 決定是否成交
   * - 排程（CRON_SECRET）：走 autoTick，自行判斷盤中／收盤／略過；收盤一天只跑一次
   */
  "POST /api/cycle": async (u, body, ctx) => {
    if (ctx.cron && !body.manual) {
      const r = await autoTick({ wait: true });
      return { ...r, time: taipeiNow(), cycle: r.cycle ? { tTaipei: r.cycle.tTaipei, source: r.cycle.source, durationMs: r.cycle.durationMs, trades: r.cycle.trades?.length || 0, decisions: r.cycle.decisions?.map((d) => `${d.symbol} ${d.action} ${d.shares}`) } : undefined };
    }
    const r = await runCycle({ execute: Boolean(body.execute), source: "manual" });
    if (ctx.cron) return { ok: true, tTaipei: r.tTaipei, durationMs: r.durationMs, aiError: r.aiError, advisors: r.advisors ? { items: r.advisors.items.length, transcripts: r.advisors.transcripts, model: r.advisors.model } : null, decisions: (r.decisions || []).map((d) => `${d.symbol} ${d.action}`) };
    return r;
  },
  // 排程密鑰可讀最近的系統日誌（排錯用）
  "GET /api/log": async (u, body, ctx) => { if (!ctx.cron) throw new HttpError(403, "需要排程密鑰"); const st = getState(); return { valuationSample: await getValuation(["2317", "6442"]).catch((e) => ({ error: e.message })), radarPe: (st.radar?.items || []).slice(0, 5).map((x) => [x.symbol, x.pe ?? null]), log: (st.log || []).slice(0, Number(u.searchParams.get("n") || 30)), risk: st.config.risk, auto: st.config.auto, lastDecisions: (st.lastCycle?.decisions || []).map((d) => `${d.symbol} ${d.action}${d.shares ? " " + d.shares : ""}：${d.reason}`) }; },
  // 飆股雷達：掃全市場找有飆股訊號的股票，投資長挑選。頁面載入時若超過 20 小時沒掃會自動觸發；排程也可叫（收盤後）
  "GET /api/radar": async () => ({ radar: getState().radar || null }),
  "POST /api/radar": async (u, body, ctx) => {
    const s = getState();
    if (!body.force && s.radar?.t && Date.now() - new Date(s.radar.t) < 30 * 60 * 1000) return { radar: s.radar, cached: true };
    if (isServerless && !(await storage.lock("radar", 240))) throw new HttpError(409, "雷達正在掃描中，請稍後再看");
    try {
      const r = await runRadar(s.config.radar, { model: s.config.ai.model || "claude-opus-5-5", effort: "low", budgetMs: isServerless ? 170 * 1000 : Infinity });
      if (r.pending) { addLog(`飆股雷達：歷史資料載入中（${r.loaded}/${r.need} 個交易日），下次呼叫繼續`); await saveState(["log"]); return { pending: true, loaded: r.loaded, need: r.need }; }
      s.radar = r;
      addLog(`飆股雷達：掃 ${r.universe} 檔，${r.candidates} 檔有訊號，投資長挑 ${(r.items || []).filter((x) => x.pick && x.pick.verdict !== "避開").length} 檔（${Math.round(r.durationMs / 1000)} 秒）`);
      await saveState(["radar", "log"]);
      return ctx.cron ? { ok: true, date: r.date, universe: r.universe, candidates: r.candidates, picks: r.items.filter((x) => x.pick).map((x) => `${x.symbol} ${x.name} ${x.pick.verdict}`) } : { radar: r };
    } finally { if (isServerless) await storage.unlock("radar").catch(() => {}); }
  },
  // 時間段兩種給法：days（最近 N 個交易日）或 from/to（YYYY-MM-DD）
  "POST /api/backtest": async (u, body) => {
    const { from, to } = normalizeRange(body);
    body = { ...body, from, to };
    if (isServerless) {
      const days = Math.min(Number(body.days) || 120, CLOUD_LIMITS.backtestDays);
      body = { ...body, symbols: (body.symbols || []).slice(0, CLOUD_LIMITS.backtestSymbols), days, maxDays: CLOUD_LIMITS.backtestDays, months: Math.ceil((days + 65) / 21) + 1 };
    }
    return runBacktest(body);
  },
  "POST /api/tune": async (u, body) => {
    const s = getState();
    const symbols = body.symbols?.length ? body.symbols : [...new Set([...Object.keys(s.positions), ...s.config.watchlist])];
    const trials = isServerless ? Math.min(body.trials || CLOUD_LIMITS.tuneTrials, CLOUD_LIMITS.tuneTrials) : body.trials || 40;
    const r = await tuneRisk({ symbols: isServerless ? symbols.slice(0, CLOUD_LIMITS.backtestSymbols) : symbols, cash: s.initialEquity || s.config.initialCash, days: Math.min(body.days || 120, isServerless ? CLOUD_LIMITS.backtestDays : 9999), baseRisk: s.config.risk, fees: s.config.fees, margin: s.config.margin, trials });
    if (body.apply !== false) {
      const keep = { oddLot: s.config.risk.oddLot, minCashPct: s.config.risk.minCashPct, minOrderAmount: s.config.risk.minOrderAmount, maxPositions: s.config.risk.maxPositions, lockStopLoss: s.config.risk.lockStopLoss };
      if (s.config.risk.lockStopLoss) keep.stopLossPct = s.config.risk.stopLossPct; // 投資長鎖定的停損不被調參改掉
      s.config.risk = { ...s.config.risk, ...r.best.risk, ...keep };
      addLog(`自動調參完成：回測 ${r.tried} 組，套用最佳參數（報酬 ${r.best.returnPct}%，回撤 ${r.best.maxDrawdownPct}%，原參數報酬 ${r.current.returnPct}%）`);
      await saveState(["config", "log"]);
    }
    return { ...r, state: publicState() };
  },
  // ---------- 投資長對話 ----------
  "GET /api/chat": async () => ({ messages: getState().chat || [], aiAvailable: aiAvailable() }),
  "POST /api/chat/clear": async () => { const s = getState(); s.chat = []; await saveState(["chat"]); return { ok: true }; },
  /** 串流（SSE）：data: {"delta":"..."} ... data: {"done":true,...} */
  "POST /api/chat": async (u, body) => {
    const s = getState();
    const msg = String(body.message || "").trim();
    if (!msg) throw new HttpError(400, "訊息是空的");
    if (!aiAvailable()) throw new HttpError(503, "找不到 ANTHROPIC_API_KEY，無法對話");
    s.chat = s.chat || [];
    s.chat.push({ role: "user", content: msg, t: new Date().toISOString() });
    const history = s.chat.slice(-CHAT_MAX).map(({ role, content }) => ({ role, content }));
    const model = s.config.chat?.model || s.config.ai.model || "claude-opus-5-5";
    const effort = s.config.chat?.effort || "low";
    const gen = chatStream({ state: s, history, model, effort });
    async function* events() {
      enterState(s); // generator 本體在 handleApi 回傳後才執行，要重新綁定這個請求的狀態
      let text = "", meta = null;
      try {
        for (;;) {
          const r = await gen.next();
          if (r.done) { meta = r.value; break; }
          if (typeof r.value !== "string") { yield r.value; continue; } // 工具進度
          text += r.value; yield { delta: r.value };
        }
        s.chat.push({ role: "assistant", content: text, t: new Date().toISOString(), model: meta?.model, usage: meta?.usage && { in: meta.usage.input_tokens, out: meta.usage.output_tokens, cached: meta.usage.cache_read_input_tokens } });
        if (s.chat.length > CHAT_MAX * 2) s.chat.splice(0, s.chat.length - CHAT_MAX * 2);
        await saveState(["chat", ...(meta?.changed || [])]);
        yield { done: true, usage: meta?.usage, model: meta?.model, refresh: Boolean(meta?.changed?.length) };
      } catch (e) {
        s.chat.pop(); // 失敗就不留這則提問
        await saveState(["chat"]).catch(() => {});
        yield { error: e.message };
      }
    }
    return { __stream: events() };
  },
  "POST /api/login": async (u, body, ctx) => {
    if (!authEnabled()) return { ok: true, auth: false };
    if (!checkPassword(body.password)) { await new Promise((r) => setTimeout(r, 800)); throw new HttpError(401, "密碼錯誤"); }
    const token = await issueSession();
    ctx.setHeader("Set-Cookie", sessionCookie(token, { secure: ctx.secure }));
    return { ok: true, auth: true };
  },
  "POST /api/logout": async (u, body, ctx) => { ctx.setHeader("Set-Cookie", clearCookie()); return { ok: true }; },
  // 不用登入；順便探測證交所是否能從這個機房連到（部署後驗收用）
  "GET /api/health": async (u) => {
    const out = { ok: true, time: taipeiNow(), backend, serverless: isServerless, auth: authEnabled(), cron: Boolean(process.env.CRON_SECRET), commit: (process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 7), lastCycle: getState()?.lastCycle?.tTaipei || null, advisorPush: (await storage.cacheGet("advisors:lastPush").catch(() => null)) || null, hasTaifex: Boolean(getState()?.lastCycle?.taifex) };
    if (u.searchParams.has("probe")) {
      const t0 = Date.now();
      try { const q = (await getQuotes(["2330"]))["2330"]; out.twse = q?.price ? `ok ${q.name} ${q.price}` : "no data"; }
      catch (e) { out.twse = "fail: " + e.message; }
      out.twseMs = Date.now() - t0;
    }
    return out;
  },
};

/**
 * 統一入口。
 * @param {{ method:string, url:URL, headers:Headers|object, body:any, secure?:boolean }} req
 * @returns {Promise<{status:number, headers:object, body:any}>}
 */
export async function handleApi(req) {
  const key = `${req.method} ${req.url.pathname}`;
  const handler = routes[key];
  if (!handler) return { status: 404, headers: {}, body: { error: "not found" } };
  const h = (k) => (req.headers.get ? req.headers.get(k) : req.headers[k]) || "";
  const cookies = parseCookies(h("cookie"));
  const cron = ["POST /api/cycle", "POST /api/advisors/transcripts", "GET /api/advisors/items", "GET /api/log", "POST /api/radar"].includes(key) && verifyCron(req.headers);
  const open = key === "POST /api/login" || key === "GET /api/health";
  // 雲端一定要設密碼，否則任何人都能看持股、用掉 Claude 額度
  if (isServerless && !authEnabled() && key !== "GET /api/health") return { status: 503, headers: {}, body: { error: "APP_PASSWORD 未設定，請在 Vercel 環境變數加入後重新部署" } };
  if (!cron && !open && !(await verifySession(cookies[COOKIE]))) return { status: 401, headers: {}, body: { error: "unauthorized", login: "/login.html" } };
  const headers = { "Cache-Control": "no-store" };
  const ctx = { cron, secure: req.secure ?? true, setHeader: (k, v) => { headers[k] = v; } };
  // Redis 模式每次請求重新讀一份，並綁在這個請求上（runWithState），不會被其他同時進行的請求換掉
  const st = await loadState({ fresh: storage.name === "redis" });
  return runWithState(st, async () => {
  try {
    const body = await handler(req.url, req.body || {}, ctx);
    if (body && body.__stream) return { status: 200, headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" }, stream: body.__stream };
    return { status: 200, headers, body };
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) {
      console.error(key, e);
      // 讓失敗出現在頁面的系統日誌，雲端沒有 console 可看
      try { if (getState()) { addLog(`${key} 失敗：${e.message}`, "error"); await saveState(["log"]); } } catch {}
    }
    return { status, headers, body: { error: e.message } };
  }
  });
}
