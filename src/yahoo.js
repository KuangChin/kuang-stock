// 國際市場：Yahoo Finance 公開 chart API（無需金鑰）
// - 指數／匯率／利率：日線，算當日漲跌與 5/20 日報酬
// - 美股期貨與個股：1 分 K 含盤前盤後，取最新價對前一日收盤（可看到盤前／夜間變化）
const UA = { "User-Agent": "Mozilla/5.0" };
export const GLOBAL_LABELS = {
  sp500: "S&P 500", nasdaq: "那斯達克", sox: "費城半導體", vix: "VIX", usdtwd: "美元/台幣", us10y: "美債10年", dxy: "美元指數",
  es: "S&P 500 期貨", nq: "那斯達克期貨", tsm: "台積電 ADR", nvda: "NVIDIA", aapl: "Apple", amd: "AMD", mu: "美光", avgo: "博通",
};
const DAILY = { sp500: "^GSPC", nasdaq: "^IXIC", sox: "^SOX", vix: "^VIX", usdtwd: "TWD=X", us10y: "^TNX", dxy: "DX-Y.NYB" };
const LIVE = { es: "ES=F", nq: "NQ=F", tsm: "TSM", nvda: "NVDA", aapl: "AAPL", amd: "AMD", mu: "MU", avgo: "AVGO" };
export const US_STOCKS = ["tsm", "nvda", "aapl", "amd", "mu", "avgo"];
let cache = { t: 0, data: null };

// Yahoo 對同時太多連線會直接斷線：限制並行 4 個，失敗最多重試 2 次
let active = 0; const queue = [];
const acquire = () => new Promise((r) => (active < 4 ? (active++, r()) : queue.push(r)));
const release = () => { const n = queue.shift(); if (n) n(); else active--; };
async function fetchChart(sym, params) {
  await acquire();
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?${params}`, { headers: UA, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const res = j.chart?.result?.[0];
    if (!res) throw new Error(j.chart?.error?.description || "no result");
    return res;
  } finally { release(); }
}
async function chart(sym, params) {
  let err;
  for (let i = 0; i < 3; i++) {
    try { return await fetchChart(sym, params); } catch (e) { err = e; await new Promise((r) => setTimeout(r, 500 * (i + 1))); }
  }
  throw err;
}
const pct = (a, b) => (a != null && b ? +(((a - b) / b) * 100).toFixed(2) : null);

async function daily(k, sym) {
  const res = await chart(sym, "range=1mo&interval=1d");
  const raw = res.indicators.quote[0].close || [], ts = res.timestamp || [];
  const bars = ts.map((t, i) => ({ t, c: raw[i] })).filter((b) => b.c != null);
  const closes = bars.map((b) => b.c);
  const price = res.meta.regularMarketPrice;
  // 最後一根若是「今天」（與 regularMarketTime 同一 UTC 日），它就是現價本身，前收要往前一根
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const lastIsToday = bars.length && day(bars[bars.length - 1].t) === day(res.meta.regularMarketTime);
  const prev = lastIsToday ? closes[closes.length - 2] : closes[closes.length - 1];
  return { symbol: sym, label: GLOBAL_LABELS[k], price, changePct: pct(price, prev), ret5: pct(price, closes[closes.length - 6]), ret20: pct(price, closes[0]) };
}

/** 期貨／個股：最新成交（含盤前盤後）對前一日收盤；session 說明現在是哪個時段 */
async function live(k, sym) {
  const res = await chart(sym, "range=1d&interval=5m&includePrePost=true");
  const m = res.meta;
  const closes = res.indicators.quote[0].close || [];
  const ts = res.timestamp || [];
  let last = null, lastTs = null;
  for (let i = closes.length - 1; i >= 0; i--) if (closes[i] != null) { last = closes[i]; lastTs = ts[i]; break; }
  const price = last ?? m.regularMarketPrice;
  const prev = m.previousClose ?? m.chartPreviousClose;
  const now = Date.now() / 1000, p = m.currentTradingPeriod || {};
  const inRange = (x) => x && now >= x.start && now < x.end;
  const session = sym.endsWith("=F") ? "futures" : inRange(p.regular) ? "regular" : inRange(p.pre) ? "pre" : inRange(p.post) ? "post" : "closed";
  return { symbol: sym, label: GLOBAL_LABELS[k], price, prev, changePct: pct(price, prev), regularPrice: m.regularMarketPrice, regularChangePct: pct(m.regularMarketPrice, prev), session, time: lastTs ? new Date(lastTs * 1000).toISOString() : null };
}

export async function getGlobalMarkets() {
  if (cache.data && Date.now() - cache.t < 10 * 60 * 1000) return cache.data;
  const out = {};
  await Promise.all([
    ...Object.entries(DAILY).map(async ([k, sym]) => { try { out[k] = await daily(k, sym); } catch (e) { console.warn("[yahoo]", sym, e.message); } }),
    ...Object.entries(LIVE).map(async ([k, sym]) => { try { out[k] = await live(k, sym); } catch (e) { console.warn("[yahoo]", sym, e.message); } }),
  ]);
  cache = { t: Date.now(), data: out };
  return out;
}
