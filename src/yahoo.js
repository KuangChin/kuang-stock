// 國際市場：Yahoo Finance 公開 chart API（無需金鑰）
const SYMBOLS = { sp500: "^GSPC", nasdaq: "^IXIC", sox: "^SOX", vix: "^VIX", usdtwd: "TWD=X", us10y: "^TNX" };
let cache = { t: 0, data: null };

export async function getGlobalMarkets() {
  if (cache.data && Date.now() - cache.t < 10 * 60 * 1000) return cache.data;
  const out = {};
  await Promise.all(Object.entries(SYMBOLS).map(async ([k, sym]) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const j = await r.json();
      const res = j.chart?.result?.[0]; if (!res) return;
      const closes = (res.indicators.quote[0].close || []).filter((v) => v != null);
      const price = res.meta.regularMarketPrice, prev = closes[closes.length - 1] === price ? closes[closes.length - 2] : closes[closes.length - 1];
      const ref5 = closes[closes.length - 6], ref20 = closes[0];
      out[k] = { symbol: sym, price, changePct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : null, ret5: ref5 ? +(((price - ref5) / ref5) * 100).toFixed(2) : null, ret20: ref20 ? +(((price - ref20) / ref20) * 100).toFixed(2) : null };
    } catch (e) { console.warn("[yahoo]", sym, e.message); }
  }));
  cache = { t: Date.now(), data: out };
  return out;
}
