// 共用路由表：本機 http 伺服器與 Vercel function 都用同一份。
// handleApi() 負責登入驗證、排程驗證、狀態載入與錯誤處理，回傳 { status, headers, body }。
import { loadState, getState, saveState, resetState, addLog } from "./store.js";
import { runCycle, symbolDetail, autoTick } from "./engine.js";
import { runBacktest } from "./backtest.js";
import { tuneRisk } from "./tuner.js";
import { getQuotes, getIndexQuotes, searchStocks, isMarketOpen, taipeiNow } from "./twse.js";
import { executeOrder, valuation } from "./portfolio.js";
import { aiAvailable } from "./analyst.js";
import { chatStream, CHAT_MAX } from "./chat.js";
import { storage, isServerless, backend } from "./storage.js";
import { authEnabled, verifySession, verifyCron, checkPassword, issueSession, sessionCookie, clearCookie, parseCookies, COOKIE } from "./auth.js";

// 雲端上的回測／調參規模上限（完整規模請在本機用 npm run backtest）
const CLOUD_LIMITS = { backtestSymbols: 4, backtestDays: 120, tuneTrials: 8 };

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function publicState() {
  const s = getState();
  return {
    config: s.config, cash: s.cash, initialEquity: s.initialEquity ?? s.config.initialCash, positions: s.positions,
    trades: s.trades.slice(0, 200), equity: s.equity.slice(-2000), lastCycle: s.lastCycle, log: s.log.slice(0, 100),
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
  "POST /api/config": async (u, body) => {
    const s = getState();
    const c = s.config;
    if (body.risk) c.risk = { ...c.risk, ...body.risk };
    if (body.weights) c.weights = { ...c.weights, ...body.weights };
    if (body.auto) c.auto = { ...c.auto, ...body.auto };
    if (body.ai) c.ai = { ...c.ai, ...body.ai };
    if (body.fees) c.fees = { ...c.fees, ...body.fees };
    if (Array.isArray(body.watchlist)) c.watchlist = [...new Set(body.watchlist.map(String).filter((x) => /^\d{4,6}$/.test(x)))];
    addLog("設定已更新");
    await saveState();
    return publicState();
  },
  "POST /api/portfolio/reset": async (u, body) => { await resetState(body); addLog(`帳戶重設：現金 ${body.cash}，持股 ${(body.positions || []).length} 檔`); return publicState(); },
  "POST /api/order": async (u, body) => {
    const s = getState();
    const q = (await getQuotes([body.symbol]))[body.symbol];
    const price = body.price || (body.side === "BUY" ? q?.bestAsk : q?.bestBid) || q?.price;
    if (!price) throw new HttpError(400, "取不到報價");
    const r = executeOrder(s, { symbol: body.symbol, side: body.side, shares: body.shares, price, name: q?.name, reason: body.reason || "手動下單", source: "manual" });
    if (r.error) throw new HttpError(400, r.error);
    addLog(`手動 ${body.side} ${body.symbol} ${body.shares} 股 @ ${price}`);
    await saveState();
    return { trade: r.trade, state: publicState() };
  },
  /**
   * 兩種呼叫方式：
   * - 已登入的使用者（頁面按鈕）：手動輪次，body.execute 決定是否成交
   * - 排程（CRON_SECRET）：走 autoTick，自行判斷盤中／收盤／略過；收盤一天只跑一次
   */
  "POST /api/cycle": async (u, body, ctx) => {
    if (ctx.cron) {
      const r = await autoTick({ wait: true });
      return { ...r, time: taipeiNow(), cycle: r.cycle ? { tTaipei: r.cycle.tTaipei, source: r.cycle.source, durationMs: r.cycle.durationMs, trades: r.cycle.trades?.length || 0, decisions: r.cycle.decisions?.map((d) => `${d.symbol} ${d.action} ${d.shares}`) } : undefined };
    }
    return runCycle({ execute: Boolean(body.execute), source: "manual" });
  },
  "POST /api/backtest": async (u, body) => {
    if (isServerless) {
      body = { ...body, symbols: (body.symbols || []).slice(0, CLOUD_LIMITS.backtestSymbols), days: Math.min(Number(body.days) || 120, CLOUD_LIMITS.backtestDays), months: 9 };
    }
    return runBacktest(body);
  },
  "POST /api/tune": async (u, body) => {
    const s = getState();
    const symbols = body.symbols?.length ? body.symbols : [...new Set([...Object.keys(s.positions), ...s.config.watchlist])];
    const trials = isServerless ? Math.min(body.trials || CLOUD_LIMITS.tuneTrials, CLOUD_LIMITS.tuneTrials) : body.trials || 40;
    const r = await tuneRisk({ symbols: isServerless ? symbols.slice(0, CLOUD_LIMITS.backtestSymbols) : symbols, cash: s.initialEquity || s.config.initialCash, days: Math.min(body.days || 120, isServerless ? CLOUD_LIMITS.backtestDays : 9999), baseRisk: s.config.risk, fees: s.config.fees, trials });
    if (body.apply !== false) {
      const keep = { oddLot: s.config.risk.oddLot, minCashPct: s.config.risk.minCashPct, minOrderAmount: s.config.risk.minOrderAmount, maxPositions: s.config.risk.maxPositions };
      s.config.risk = { ...s.config.risk, ...r.best.risk, ...keep };
      addLog(`自動調參完成：回測 ${r.tried} 組，套用最佳參數（報酬 ${r.best.returnPct}%，回撤 ${r.best.maxDrawdownPct}%，原參數報酬 ${r.current.returnPct}%）`);
      await saveState();
    }
    return { ...r, state: publicState() };
  },
  // ---------- 投資長對話 ----------
  "GET /api/chat": async () => ({ messages: getState().chat || [], aiAvailable: aiAvailable() }),
  "POST /api/chat/clear": async () => { const s = getState(); s.chat = []; await saveState(); return { ok: true }; },
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
      let text = "", meta = null;
      try {
        for (;;) {
          const r = await gen.next();
          if (r.done) { meta = r.value; break; }
          text += r.value; yield { delta: r.value };
        }
        s.chat.push({ role: "assistant", content: text, t: new Date().toISOString(), model: meta?.model, usage: meta?.usage && { in: meta.usage.input_tokens, out: meta.usage.output_tokens, cached: meta.usage.cache_read_input_tokens } });
        if (s.chat.length > CHAT_MAX * 2) s.chat.splice(0, s.chat.length - CHAT_MAX * 2);
        await saveState();
        yield { done: true, usage: meta?.usage, model: meta?.model };
      } catch (e) {
        s.chat.pop(); // 失敗就不留這則提問
        await saveState().catch(() => {});
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
    const out = { ok: true, time: taipeiNow(), backend, serverless: isServerless, auth: authEnabled(), cron: Boolean(process.env.CRON_SECRET) };
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
  const cron = key === "POST /api/cycle" && verifyCron(req.headers);
  const open = key === "POST /api/login" || key === "GET /api/health";
  // 雲端一定要設密碼，否則任何人都能看持股、用掉 Claude 額度
  if (isServerless && !authEnabled() && key !== "GET /api/health") return { status: 503, headers: {}, body: { error: "APP_PASSWORD 未設定，請在 Vercel 環境變數加入後重新部署" } };
  if (!cron && !open && !(await verifySession(cookies[COOKIE]))) return { status: 401, headers: {}, body: { error: "unauthorized", login: "/login.html" } };
  const headers = { "Cache-Control": "no-store" };
  const ctx = { cron, secure: req.secure ?? true, setHeader: (k, v) => { headers[k] = v; } };
  try {
    // Redis 模式每次請求重新讀取，確保看到排程寫入的最新狀態
    await loadState({ fresh: storage.name === "redis" });
    const body = await handler(req.url, req.body || {}, ctx);
    if (body && body.__stream) return { status: 200, headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" }, stream: body.__stream };
    return { status: 200, headers, body };
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(key, e);
    return { status, headers, body: { error: e.message } };
  }
}
