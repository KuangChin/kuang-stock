// 指數、台指期、國際市場與個股的日線歷史，給投資長對話查「過去 N 天」用。
// - 加權指數、費半、S&P 500 等：Yahoo Finance 日線（快取 1 小時）
// - 台指期：期交所每日行情下載（futDataDown，Big5 CSV），按月快取；取每天「一般」時段成交量最大的合約當近月連續
// - 個股：證交所／櫃買月資料（twse.js），自動還原分割
import { storage } from "./storage.js";
import { getDailyHistory } from "./twse.js";
import { adjustSplits } from "./backtest.js";
import { GLOBAL_LABELS } from "./yahoo.js";

const UA = { "User-Agent": "Mozilla/5.0" };
export const SERIES = {
  taiex: { sym: "^TWII", label: "加權指數" }, tx: { label: "台指期（近月連續）" },
  sox: { sym: "^SOX", label: "費城半導體" }, sp500: { sym: "^GSPC", label: "S&P 500" }, nasdaq: { sym: "^IXIC", label: "那斯達克" },
  vix: { sym: "^VIX", label: "VIX" }, usdtwd: { sym: "TWD=X", label: "美元/台幣" }, us10y: { sym: "^TNX", label: "美債10年" }, dxy: { sym: "DX-Y.NYB", label: "美元指數" },
  tsm: { sym: "TSM", label: "台積電 ADR" }, nvda: { sym: "NVDA", label: "NVIDIA" },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (t) => new Date(t * 1000).toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });

async function yahooDaily(sym, range = "2y") {
  const key = `hist:yahoo:${sym}:${range}`;
  const hit = await storage.cacheGet(key, 60 * 60 * 1000).catch(() => null);
  if (hit) return hit;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`, { headers: UA, signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  const res = j.chart?.result?.[0];
  if (!res) throw new Error(j.chart?.error?.description || "Yahoo 沒有資料");
  const q = res.indicators.quote[0], ts = res.timestamp || [];
  const bars = ts.map((t, i) => ({ date: day(t), open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] })).filter((b) => b.close != null).map((b) => ({ ...b, open: +b.open?.toFixed(2), high: +b.high?.toFixed(2), low: +b.low?.toFixed(2), close: +b.close.toFixed(2) }));
  await storage.cacheSet(key, bars).catch(() => {});
  return bars;
}

const num = (s) => { const v = parseFloat(String(s ?? "").replace(/[,%\s]/g, "")); return Number.isFinite(v) ? v : null; };
/** 期交所某月的台指期日行情（近月連續） */
async function taifexMonth(ym) {
  const now = new Date();
  const isCurrent = ym === `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const key = `hist:taifex:TX:${ym}`;
  const hit = await storage.cacheGet(key, isCurrent ? 30 * 60 * 1000 : 365 * 86400e3).catch(() => null);
  if (hit) return hit;
  const y = ym.slice(0, 4), m = ym.slice(4);
  const last = new Date(Number(y), Number(m), 0).getDate();
  const body = `down_type=1&commodity_id=TX&queryStartDate=${y}/${m}/01&queryEndDate=${y}/${m}/${last}`;
  const r = await fetch("https://www.taifex.com.tw/cht/3/futDataDown", { method: "POST", headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`taifex HTTP ${r.status}`);
  const text = new TextDecoder("big5").decode(await r.arrayBuffer());
  const byDate = {};
  for (const line of text.split("\n").slice(1)) {
    const c = line.split(",");
    if (c.length < 18 || c[1].trim() !== "TX" || c[17].trim() !== "一般") continue;
    const date = c[0].trim().replace(/\//g, "-"), vol = num(c[9]) ?? 0;
    const bar = { date, contract: c[2].trim(), open: num(c[3]), high: num(c[4]), low: num(c[5]), close: num(c[6]), settle: num(c[10]), volume: vol, oi: num(c[11]) };
    if (bar.close == null) continue;
    if (!byDate[date] || vol > byDate[date].volume) byDate[date] = bar; // 成交量最大的是近月
  }
  const bars = Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (bars.length || !isCurrent) await storage.cacheSet(key, bars).catch(() => {});
  return bars;
}

async function taifexDaily(days) {
  const now = new Date();
  const months = Math.ceil(days / 20) + 1;
  const bars = [];
  for (let k = months - 1; k >= 0; k--) {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    try { bars.push(...(await taifexMonth(ym))); } catch (e) { console.warn(`[history] taifex ${ym}:`, e.message); }
    await sleep(300);
  }
  return bars;
}

/** 回傳日線（舊 -> 新），series 可以是 SERIES 的 key 或 4～6 位數的股票代碼 */
export async function getSeries(series, { days = 240, from = null, to = null } = {}) {
  const key = String(series).toLowerCase();
  let bars, label;
  if (/^\d{4,6}$/.test(key)) { bars = adjustSplits(await getDailyHistory(key, { months: Math.ceil(days / 20) + 2, from, to })); label = key; }
  else if (key === "tx") { bars = await taifexDaily(from ? 500 : days); label = SERIES.tx.label; }
  else if (SERIES[key]) { bars = await yahooDaily(SERIES[key].sym, days > 480 ? "5y" : "2y"); label = SERIES[key].label || GLOBAL_LABELS[key]; }
  else throw new Error(`不認識的序列 ${series}，可用：${Object.keys(SERIES).join("、")} 或股票代碼`);
  if (from) bars = bars.filter((b) => b.date >= from);
  if (to) bars = bars.filter((b) => b.date <= to);
  if (!from) bars = bars.slice(-days);
  return { series: key, label, bars };
}

const pct = (a, b) => (a != null && b ? +(((a - b) / b) * 100).toFixed(2) : null);
const ma = (arr, n) => (arr.length >= n ? +(arr.slice(-n).reduce((s, v) => s + v, 0) / n).toFixed(2) : null);
/** 把日線壓成投顧看得懂、又不吃太多 token 的摘要：統計 + 約 50 個取樣點 */
export function summarizeSeries({ series, label, bars }, points = 50) {
  if (!bars.length) return { series, label, error: "沒有資料" };
  const closes = bars.map((b) => b.close);
  const first = bars[0], last = bars[bars.length - 1];
  let hi = bars[0], lo = bars[0], peak = -Infinity, mdd = 0, mddDate = null;
  for (const b of bars) {
    if (b.close > hi.close) hi = b; if (b.close < lo.close) lo = b;
    peak = Math.max(peak, b.close); const dd = (peak - b.close) / peak; if (dd > mdd) { mdd = dd; mddDate = b.date; }
  }
  const step = Math.max(1, Math.ceil(bars.length / points));
  const sampled = bars.filter((b, i) => i % step === 0 || i === bars.length - 1).map((b) => [b.date, b.close]);
  return {
    series, label, days: bars.length, start: first.date, end: last.date, startClose: first.close, endClose: last.close, returnPct: pct(last.close, first.close),
    high: { date: hi.date, close: hi.close }, low: { date: lo.date, close: lo.close }, maxDrawdownPct: +(mdd * 100).toFixed(2), maxDrawdownDate: mddDate,
    ma20: ma(closes, 20), ma60: ma(closes, 60), ma120: ma(closes, 120), ma240: ma(closes, 240),
    ret20: pct(last.close, closes[closes.length - 21]), ret60: pct(last.close, closes[closes.length - 61]), ret120: pct(last.close, closes[closes.length - 121]),
    sampled, sampledNote: `每 ${step} 個交易日取一點 [日期, 收盤]`,
  };
}
