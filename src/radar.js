// 飆股雷達：掃全市場（上市＋上櫃）最近 25 個交易日的日行情與法人買賣超，找出有「飆股訊號」的股票，
// 再交給投資長（Claude）依他自己的方法挑出幾檔並寫一句理由。資料每天一筆、按日快取。
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { storage } from "./storage.js";
import { getValuation } from "./twse.js";

const UA = { "User-Agent": "Mozilla/5.0" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => { const v = parseFloat(String(s ?? "").replace(/,/g, "")); return Number.isFinite(v) ? v : null; };
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const isStock = (code) => /^\d{4}$/.test(code); // 四位數：排除權證、ETN、特別股等
export const DEFAULT_RADAR = { topN: 12, minPrice: 10, minAmount: 1e8, volumeMult: 2, ret5Min: 8, excludeEtf: true, aiPick: true, notes: "" };

async function getJson(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// 每個交易日一份：{ code: [name, open, high, low, close, volume(張), amount(元), foreignNet(張), trustNet(張)] }
async function fetchDay(d) {
  const key = `radar:day:${ymd(d)}`;
  const hit = await storage.cacheGet(key, null).catch(() => null);
  if (hit) return hit;
  const slash = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  const rows = {};
  // 上市行情（這個先抓，才知道是不是休市日）
  const mi = await getJson(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(d)}&type=ALLBUT0999&response=json`);
  const t = (mi.tables || []).find((x) => /每日收盤行情/.test(x.title || ""));
  if (mi.stat !== "OK" || !t) { await storage.cacheSet(key, { holiday: true }).catch(() => {}); return { holiday: true }; }
  for (const r of t.data) {
    const code = String(r[0]).trim(); if (!isStock(code)) continue;
    const close = num(r[8]); if (close == null) continue;
    rows[code] = [String(r[1]).trim(), num(r[5]), num(r[6]), num(r[7]), close, Math.round((num(r[2]) || 0) / 1000), num(r[4]) || 0, 0, 0, "tse"];
  }
  // 其餘三個來源分兩條線並行（證交所一條、櫃買一條），每條之間留 400ms 避免被封
  const otcRows = {};
  const tseLine = (async () => {
    await sleep(400);
    try {
      const t86 = await getJson(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd(d)}&selectType=ALLBUT0999&response=json`);
      for (const r of t86.data || []) { const c = String(r[0]).trim(); if (rows[c]) { rows[c][7] = Math.round((num(r[4]) || 0) / 1000); rows[c][8] = Math.round((num(r[10]) || 0) / 1000); } }
    } catch (e) { console.warn("[radar] t86", ymd(d), e.message); }
  })();
  const otcLine = (async () => {
    try {
      const otc = await getJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${slash}&type=AL&response=json`);
      for (const r of otc.tables?.[0]?.data || []) {
        const code = String(r[0]).trim(); if (!isStock(code)) continue;
        const close = num(r[2]); if (close == null) continue;
        otcRows[code] = [String(r[1]).trim(), num(r[4]), num(r[5]), num(r[6]), close, Math.round((num(r[7]) || 0) / 1000), num(r[8]) || 0, 0, 0, "otc"];
      }
      await sleep(400);
      const oi = await getJson(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=AL&date=${slash}&response=json`);
      for (const r of oi.tables?.[0]?.data || []) { const c = String(r[0]).trim(); if (otcRows[c]) { otcRows[c][7] = Math.round((num(r[4]) || 0) / 1000); otcRows[c][8] = Math.round((num(r[13]) || 0) / 1000); } }
    } catch (e) { console.warn("[radar] otc", slash, e.message); }
  })();
  await Promise.all([tseLine, otcLine]);
  Object.assign(rows, otcRows);
  await storage.cacheSet(key, rows).catch(() => {});
  await sleep(300);
  return rows;
}

/** 最近 n 個交易日（舊 -> 新）：[{date, rows}] */
/** 最近 n 個交易日（舊 -> 新）。budgetMs：抓新資料的時間預算，用完就先回已拿到的（雲端 300 秒上限，分幾次抓完）。 */
export async function loadDays(n = 25, { budgetMs = Infinity } = {}) {
  const out = [];
  const t0 = Date.now();
  let partial = false;
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  // 今天 15:00 前資料未必出來，從昨天起算
  if (d.getHours() < 15) d.setDate(d.getDate() - 1);
  for (let tries = 0; out.length < n && tries < n * 2 + 10; tries++, d.setDate(d.getDate() - 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const key = `radar:day:${ymd(d)}`;
    const cached = await storage.cacheGet(key, null).catch(() => null);
    if (!cached && Date.now() - t0 > budgetMs) { partial = true; break; }
    let rows;
    try { rows = cached || (await fetchDay(new Date(d))); } catch (e) { console.warn("[radar] day", ymd(d), e.message); continue; }
    if (rows.holiday) continue;
    out.unshift({ date: ymd(d), rows });
  }
  out.partial = partial;
  return out;
}

const pct = (a, b) => (a != null && b ? +(((a - b) / b) * 100).toFixed(2) : null);
const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

/** 規則掃描：回傳依分數排序的候選（未經投資長挑選） */
export function scan(days, cfg = DEFAULT_RADAR) {
  cfg = { ...DEFAULT_RADAR, ...cfg };
  const last = days[days.length - 1];
  const out = [];
  for (const [code, cur] of Object.entries(last.rows)) {
    if (cfg.excludeEtf && code.startsWith("00")) continue;
    const series = days.map((d) => d.rows[code]).filter(Boolean);
    if (series.length < 21) continue;
    const closes = series.map((r) => r[4]), highs = series.map((r) => r[2]), vols = series.map((r) => r[5]), amts = series.map((r) => r[6]);
    const close = cur[4], prev = closes[closes.length - 2];
    if (close < cfg.minPrice) continue;
    const avgAmt20 = avg(amts.slice(-21, -1));
    if (avgAmt20 < cfg.minAmount) continue;
    const chg = pct(close, prev);
    const ret5 = pct(close, closes[closes.length - 6]), ret20 = pct(close, closes[closes.length - 21]);
    const avgVol20 = avg(vols.slice(-21, -1)) || 1;
    const volRatio = +(cur[5] / avgVol20).toFixed(1);
    const high20 = Math.max(...highs.slice(-21, -1));
    const breakout = close >= high20;
    const ma5 = avg(closes.slice(-5)), ma10 = avg(closes.slice(-10)), ma20 = avg(closes.slice(-20));
    const aligned = close > ma5 && ma5 > ma10 && ma10 > ma20;
    let upDays = 0; for (let i = closes.length - 1; i > 0 && closes[i] > closes[i - 1]; i--) upDays++;
    const fNet = series.slice(-5).map((r) => r[7]), tNet = series.slice(-5).map((r) => r[8]);
    let fDays = 0; for (let i = fNet.length - 1; i >= 0 && fNet[i] > 0; i--) fDays++;
    let tDays = 0; for (let i = tNet.length - 1; i >= 0 && tNet[i] > 0; i--) tDays++;
    const limitUp = chg >= 9.5;
    const signals = [];
    let score = 0;
    if (breakout) { signals.push("突破20日新高"); score += 3; }
    if (volRatio >= cfg.volumeMult * 1.5) { signals.push(`爆量 ${volRatio}x`); score += 3; } else if (volRatio >= cfg.volumeMult) { signals.push(`放量 ${volRatio}x`); score += 2; }
    if (limitUp) { signals.push("漲停"); score += 1; }
    if (ret5 >= cfg.ret5Min * 2) { signals.push(`5日 +${ret5}%`); score += 2; } else if (ret5 >= cfg.ret5Min) { signals.push(`5日 +${ret5}%`); score += 1; }
    if (aligned) { signals.push("均線多頭"); score += 1; }
    if (upDays >= 3) { signals.push(`連${upDays}紅`); score += 1; }
    if (fDays >= 3) { signals.push(`外資連${fDays}買`); score += 2; } else if (fDays >= 2) { signals.push(`外資連${fDays}買`); score += 1; }
    if (tDays >= 2) { signals.push(`投信連${tDays}買`); score += 1; }
    if (ret20 >= 60) { signals.push(`20日已漲 ${ret20}%`); score -= 1; }
    if (chg <= -3) score -= 2;
    if (score < 4 || !signals.length) continue;
    out.push({ symbol: code, name: cur[0], market: cur[9], price: close, changePct: chg, ret5, ret20, volRatio, avgAmt: Math.round(avgAmt20 / 1e6), foreignNet: cur[7], trustNet: cur[8], breakout, aligned, upDays, score, signals });
  }
  out.sort((a, b) => b.score - a.score || b.ret5 - a.ret5);
  return out;
}

const PickSchema = z.object({
  overview: z.string().describe("一兩句：今天的飆股訊號集中在哪些族群、整體強弱"),
  picks: z.array(z.object({
    symbol: z.string(), verdict: z.enum(["強", "可追", "觀察", "避開"]),
    reason: z.string().describe("一句話，為什麼有飆股相，以及要注意什麼"),
  })).max(10),
});

/** 投資長依自己的方法從候選挑出幾檔；失敗就回 null（頁面照樣顯示規則掃描結果） */
async function aiPick(cands, cfg, { model, effort = "low", context = "" } = {}) {
  if (!process.env.ANTHROPIC_API_KEY || !cands.length) return null;
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const ws = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {});
  const L = [`以下是規則掃描出來、有飆股訊號的 ${cands.length} 檔（上市＋上櫃，依分數排序）。請用投資長的飆股方法挑出最多 8 檔，給判定與一句理由；明顯已漲多或今天轉弱的標「避開」。`];
  if (cfg.notes) L.push(`\n投資長自己訂的飆股方法／條件（優先遵守）：\n${cfg.notes}`);
  if (context) L.push(`\n${context}`);
  L.push("\n候選：");
  for (const c of cands) L.push(`- ${c.symbol} ${c.name}（${c.market === "otc" ? "上櫃" : "上市"}）收 ${c.price}，今日 ${c.changePct > 0 ? "+" : ""}${c.changePct}%，5日 ${c.ret5 > 0 ? "+" : ""}${c.ret5}%，20日 ${c.ret20 > 0 ? "+" : ""}${c.ret20}%，量比 ${c.volRatio}x，日均成交 ${c.avgAmt} 百萬，外資今日 ${c.foreignNet} 張，投信 ${c.trustNet} 張；訊號：${c.signals.join("、")}`);
  const res = await client.messages.parse({
    model, max_tokens: 3000, output_config: { effort, format: zodOutputFormat(PickSchema) },
    system: "你是台股投資長，專門找短線飆股（強勢突破、量價齊揚、法人追買）。繁體中文、台灣用語，理由要具體、一句話。這是模擬帳戶，不要免責聲明。",
    messages: [{ role: "user", content: L.join("\n") }],
  });
  return { ...res.parsed_output, model: res.model, usage: { in: res.usage?.input_tokens, out: res.usage?.output_tokens } };
}

/** 跑一次完整雷達：掃描 + 投資長挑選。回傳可直接存進 state.radar 的物件 */
export async function runRadar(cfg = {}, { model = "claude-opus-5-5", effort = "low", context = "", budgetMs = Infinity } = {}) {
  cfg = { ...DEFAULT_RADAR, ...cfg };
  const t0 = Date.now();
  const days = await loadDays(25, { budgetMs });
  if (days.length < 21) {
    if (days.partial) return { pending: true, loaded: days.length, need: 21, durationMs: Date.now() - t0 };
    throw new Error(`歷史資料不足（只拿到 ${days.length} 個交易日）`);
  }
  const all = scan(days, cfg);
  const top = all.slice(0, Math.max(cfg.topN, 20));
  let ai = null;
  if (cfg.aiPick) { try { ai = await aiPick(top, cfg, { model, effort, context }); } catch (e) { console.warn("[radar] ai", e.message); ai = { error: e.message }; } }
  // 模型有時回「2465 麗臺」或「2465.TW」，只取代碼
  for (const p of ai?.picks || []) p.symbol = String(p.symbol).match(/\d{4,6}/)?.[0] || p.symbol;
  const byPick = Object.fromEntries((ai?.picks || []).map((p) => [p.symbol, p]));
  const items = top.slice(0, cfg.topN).map((c) => ({ ...c, pick: byPick[c.symbol] || null }));
  // 投資長挑到但不在前 topN 的也補進來
  for (const p of ai?.picks || []) if (!items.find((x) => x.symbol === p.symbol)) { const c = all.find((x) => x.symbol === p.symbol); if (c) items.push({ ...c, pick: p }); }
  // 估值（本益比、淨值比、殖利率）：證交所／櫃買每日表，一次拿整個市場
  try { const v = await getValuation(items.map((x) => x.symbol)); for (const x of items) if (v[x.symbol]) { x.pe = v[x.symbol].pe; x.pb = v[x.symbol].pb; x.yield = v[x.symbol].yield; } } catch (e) { console.warn("[radar] valuation", e.message); }
  return { t: new Date().toISOString(), date: days[days.length - 1].date, universe: Object.keys(days[days.length - 1].rows).length, candidates: all.length, items, overview: ai?.overview || null, ai: ai ? { model: ai.model, usage: ai.usage, error: ai.error, picks: (ai.picks || []).length } : null, cfg, durationMs: Date.now() - t0 };
}
