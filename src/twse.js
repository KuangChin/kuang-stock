// 台灣證交所 / 櫃買中心 公開資料存取層
// - 即時報價：mis.twse.com.tw（約 5 秒更新，無需金鑰）
// - 日成交資料：www.twse.com.tw（上市）/ www.tpex.org.tw（上櫃）
// - 代碼對照：openapi.twse.com.tw / www.tpex.org.tw/openapi
import { storage } from "./storage.js";

const UA = { "User-Agent": "Mozilla/5.0 (kuang-stock paper-trading)", Accept: "application/json, text/plain, */*" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
};
const rocToIso = (roc) => {
  // "114/11/03" -> "2025-11-03"
  const [y, m, d] = roc.split("/").map((x) => parseInt(x, 10));
  return `${y + 1911}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

async function fetchJson(url, { timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// 快取：本機存 data/cache/*.json（以 mtime 判斷新舊），雲端存 Redis（30 天過期）
const readCache = (key, maxAgeMs) => storage.cacheGet(key, maxAgeMs).catch(() => null);
const writeCache = (key, data) => storage.cacheSet(key, data).catch((e) => console.warn("[cache] write failed:", key, e.message));

// ---------- 代碼對照（上市 + 上櫃） ----------
let listingCache = null;
export async function getListing() {
  if (listingCache) return listingCache;
  const cached = await readCache("listing", 24 * 3600 * 1000);
  if (cached) return (listingCache = cached);
  const map = {};
  try {
    const tse = await fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
    for (const r of tse) map[r.Code] = { name: r.Name, market: "tse" };
  } catch (e) {
    console.warn("[twse] listing tse failed:", e.message);
  }
  try {
    const otc = await fetchJson("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes");
    for (const r of otc) map[r.SecuritiesCompanyCode] = { name: r.CompanyName, market: "otc" };
  } catch (e) {
    console.warn("[twse] listing otc failed:", e.message);
  }
  if (Object.keys(map).length) await writeCache("listing", map);
  return (listingCache = map);
}

export async function searchStocks(q, limit = 10) {
  const list = await getListing();
  q = (q || "").trim();
  if (!q) return [];
  const out = [];
  for (const [code, v] of Object.entries(list)) {
    if (code.startsWith(q) || v.name.includes(q)) out.push({ code, name: v.name, market: v.market });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- 即時報價 ----------
function parseQuote(m) {
  const last = num(m.z) ?? num(m.pz);
  const prev = num(m.y);
  const asks = (m.a || "").split("_").filter(Boolean).map(num);
  const bids = (m.b || "").split("_").filter(Boolean).map(num);
  const askVol = (m.f || "").split("_").filter(Boolean).map(num);
  const bidVol = (m.g || "").split("_").filter(Boolean).map(num);
  // 無成交時以買賣中價或昨收估價
  const price = last ?? (asks[0] && bids[0] ? (asks[0] + bids[0]) / 2 : prev);
  return {
    symbol: m.c,
    name: m.n,
    market: m.ex,
    price,
    last,
    prevClose: prev,
    open: num(m.o),
    high: num(m.h),
    low: num(m.l),
    volume: num(m.v), // 張
    change: price != null && prev != null ? +(price - prev).toFixed(2) : null,
    changePct: price != null && prev ? +(((price - prev) / prev) * 100).toFixed(2) : null,
    bestAsk: asks[0] ?? null,
    bestBid: bids[0] ?? null,
    asks: asks.map((p, i) => ({ price: p, vol: askVol[i] ?? null })),
    bids: bids.map((p, i) => ({ price: p, vol: bidVol[i] ?? null })),
    time: m.t,
    date: m.d ? `${m.d.slice(0, 4)}-${m.d.slice(4, 6)}-${m.d.slice(6, 8)}` : null,
    limitUp: num(m.u),
    limitDown: num(m.w),
  };
}

export async function getQuotes(symbols) {
  symbols = [...new Set(symbols.map(String))];
  if (!symbols.length) return {};
  const listing = await getListing();
  const out = {};
  for (let i = 0; i < symbols.length; i += 20) {
    const chunk = symbols.slice(i, i + 20);
    const ex = chunk
      .flatMap((s) => {
        const mk = listing[s]?.market;
        return mk ? [`${mk}_${s}.tw`] : [`tse_${s}.tw`, `otc_${s}.tw`];
      })
      .join("|");
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}&json=1&delay=0&_=${Date.now()}`;
    const j = await fetchJson(url);
    for (const m of j.msgArray || []) if (m.c) out[m.c] = parseQuote(m);
    if (i + 20 < symbols.length) await sleep(300);
  }
  return out;
}

export async function getIndexQuotes() {
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw|otc_o00.tw&json=1&delay=0&_=${Date.now()}`;
  const j = await fetchJson(url);
  const out = {};
  for (const m of j.msgArray || []) {
    const q = parseQuote(m);
    out[m.ex === "tse" ? "taiex" : "otc"] = { ...q, name: m.ex === "tse" ? "加權指數" : "櫃買指數" };
  }
  return out;
}

// ---------- 日成交歷史 ----------
function monthKey(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function fetchMonthTse(symbol, ym) {
  const j = await fetchJson(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ym}01&stockNo=${symbol}`);
  if (j.stat !== "OK" || !Array.isArray(j.data)) return [];
  return j.data.map((r) => ({
    date: rocToIso(r[0]),
    volume: Math.round((num(r[1]) ?? 0) / 1000), // 股 -> 張
    open: num(r[3]),
    high: num(r[4]),
    low: num(r[5]),
    close: num(r[6]),
  }));
}

async function fetchMonthOtc(symbol, ym) {
  const j = await fetchJson(
    `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${symbol}&date=${ym.slice(0, 4)}/${ym.slice(4)}/01&response=json`
  );
  const rows = j.tables?.[0]?.data || [];
  return rows.map((r) => ({
    date: rocToIso(r[0]),
    volume: Math.round(num(r[1]) ?? 0), // 仟股 = 張
    open: num(r[3]),
    high: num(r[4]),
    low: num(r[5]),
    close: num(r[6]),
  }));
}

/**
 * 取得日線（舊 -> 新），自動快取。預設最近 months 個月；給 from/to（YYYY-MM-DD）就抓那個時間段。
 * 當月資料快取 30 分鐘，過去月份永久快取。
 */
export async function getDailyHistory(symbol, { months = 7, from = null, to = null } = {}) {
  const listing = await getListing();
  const market = listing[symbol]?.market || "tse";
  const now = new Date();
  const nowYm = monthKey(now);
  // 月份清單：有 from 就從 from 的月份起算（到 to 或今天）；否則最近 months 個月
  const end = to ? new Date(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
  const start = from ? new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, 1) : new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);
  const bars = [];
  for (let d = new Date(start); d <= end && d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const ym = monthKey(d);
    const key = `hist_${market}_${symbol}_${ym}`;
    const isCurrent = ym === nowYm;
    let rows = await readCache(key, isCurrent ? 30 * 60 * 1000 : null);
    if (!rows) {
      try {
        rows = market === "otc" ? await fetchMonthOtc(symbol, ym) : await fetchMonthTse(symbol, ym);
        await writeCache(key, rows);
        await sleep(350); // 證交所對高頻請求會封鎖
      } catch (e) {
        console.warn(`[twse] history ${symbol} ${ym} failed:`, e.message);
        rows = [];
      }
    }
    bars.push(...rows);
  }
  return bars.filter((b) => b.close != null && (!from || b.date >= from) && (!to || b.date <= to)).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 判斷台股是否開盤中（台北時間 週一至五 09:00-13:30） */
export function isMarketOpen(date = new Date()) {
  const tw = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const day = tw.getDay();
  if (day === 0 || day === 6) return false;
  const mins = tw.getHours() * 60 + tw.getMinutes();
  return mins >= 9 * 60 && mins <= 13 * 60 + 30;
}

export function taipeiNow() {
  return new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
}

// ====================== 籌碼面 ======================
const tradingDaysBack = (n) => {
  // 回推 n 個「可能的」交易日（略過週末；國定假日由 API 回空處理）
  const out = [];
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  while (out.length < n) {
    if (d.getDay() >= 1 && d.getDay() <= 5) out.push(new Date(d));
    d.setDate(d.getDate() - 1);
  }
  return out;
};
const ymd = (d, sep = "") => `${d.getFullYear()}${sep}${String(d.getMonth() + 1).padStart(2, "0")}${sep}${String(d.getDate()).padStart(2, "0")}`;

async function instiDayTse(d) {
  const key = `t86_${ymd(d)}`;
  const isToday = ymd(d) === ymd(new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" })));
  let rows = await readCache(key, isToday ? 20 * 60 * 1000 : null);
  if (rows) return rows;
  try {
    const j = await fetchJson(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd(d)}&selectType=ALLBUT0999&response=json`);
    rows = j.stat === "OK" ? Object.fromEntries((j.data || []).map((r) => [r[0].trim(), { foreign: num(r[4]) + (num(r[7]) || 0), trust: num(r[10]), dealer: num(r[11]), total: num(r[18]) }])) : {};
  } catch (e) { rows = {}; }
  await writeCache(key, rows);
  await sleep(350);
  return rows;
}
async function instiDayOtc(d) {
  const key = `tpexinsti_${ymd(d)}`;
  const isToday = ymd(d) === ymd(new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" })));
  let rows = await readCache(key, isToday ? 20 * 60 * 1000 : null);
  if (rows) return rows;
  try {
    const j = await fetchJson(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${ymd(d, "/")}&response=json`);
    const data = j.tables?.[0]?.data || [];
    // 欄位：代號,名稱, 外資及陸資(不含自營) 買/賣/超, 外資自營 買/賣/超, 外資合計 買/賣/超, 投信 買/賣/超, 自營(自行) 買/賣/超, 自營(避險) 買/賣/超, 自營合計 買/賣/超, 三大法人合計
    rows = Object.fromEntries(data.map((r) => [r[0].trim(), { foreign: num(r[10]), trust: num(r[13]), dealer: num(r[22]), total: num(r[23]) }]));
  } catch (e) { rows = {}; }
  await writeCache(key, rows);
  await sleep(350);
  return rows;
}

/** 最近 days 個交易日的三大法人買賣超（股），依 symbol 回傳序列（舊 -> 新） */
export async function getInstitutional(symbols, { days = 10 } = {}) {
  const listing = await getListing();
  const needTse = symbols.some((s) => (listing[s]?.market || "tse") === "tse");
  const needOtc = symbols.some((s) => listing[s]?.market === "otc");
  const out = Object.fromEntries(symbols.map((s) => [s, []]));
  for (const d of tradingDaysBack(days + 4).reverse()) {
    const tse = needTse ? await instiDayTse(d) : {};
    const otc = needOtc ? await instiDayOtc(d) : {};
    if (!Object.keys(tse).length && !Object.keys(otc).length) continue;
    for (const s of symbols) {
      const r = tse[s] || otc[s];
      if (r) out[s].push({ date: ymd(d, "-"), ...r });
    }
  }
  for (const s of symbols) out[s] = out[s].slice(-days);
  return out;
}

/** 融資融券（上市，最新一日） */
export async function getMargin(symbols) {
  let rows = await readCache("margin", 60 * 60 * 1000);
  if (!rows) {
    try {
      const j = await fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN");
      rows = Object.fromEntries(j.map((r) => [r["股票代號"], { marginToday: num(r["融資今日餘額"]), marginPrev: num(r["融資前日餘額"]), marginLimit: num(r["融資限額"]), shortToday: num(r["融券今日餘額"]), shortPrev: num(r["融券前日餘額"]) }]));
      await writeCache("margin", rows);
    } catch (e) { console.warn("[twse] margin failed:", e.message); rows = {}; }
  }
  return Object.fromEntries(symbols.map((s) => [s, rows[s] || null]));
}

// ====================== 基本面 ======================
/**
 * 本益比／淨值比／殖利率。先走 openapi（整份一次拿），雲端機房常連不到 openapi 時，
 * 退回 www.twse.com.tw 的 BWIBBU_d 與櫃買 peQryDate（最近一個交易日，往前最多找 6 天）。
 */
export async function getValuation(symbols) {
  let rows = await readCache("valuation", 6 * 60 * 60 * 1000);
  if (!rows) {
    rows = {};
    let tse = 0, otc = 0;
    try { const j = await fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_d"); for (const r of j) { rows[r.Code] = { pe: num(r.PEratio), pb: num(r.PBratio), yield: num(r.DividendYield), date: r.Date }; tse++; } } catch (e) { console.warn("[twse] BWIBBU_d openapi failed:", e.message); }
    try { const j = await fetchJson("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis"); for (const r of j) { rows[r.SecuritiesCompanyCode] = { pe: num(r.PriceEarningRatio), pb: num(r.PriceBookRatio), yield: num(r.YieldRatio), dps: num(r.DividendPerShare), date: r.Date }; otc++; } } catch (e) { console.warn("[twse] tpex peratio openapi failed:", e.message); }
    if (!tse || !otc) {
      const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
      if (d.getHours() < 16) d.setDate(d.getDate() - 1);
      for (let k = 0; k < 6 && (!tse || !otc); k++, d.setDate(d.getDate() - 1)) {
        if (d.getDay() === 0 || d.getDay() === 6) continue;
        const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
        if (!tse) {
          try { const j = await fetchJson(`https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=${ymd}&selectType=ALL&response=json`); if (j.stat === "OK") for (const r of j.data || []) { rows[r[0]] = { pe: num(r[5]), pb: num(r[6]), yield: num(r[3]), date: ymd }; tse++; } } catch (e) { console.warn("[twse] BWIBBU_d www failed:", e.message); }
          await sleep(300);
        }
        if (!otc) {
          try { const j = await fetchJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date=${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}&response=json`); for (const r of j.tables?.[0]?.data || []) { rows[String(r[0]).trim()] = { pe: num(r[2]), pb: num(r[6]), yield: num(r[5]), dps: num(r[3]), date: ymd }; otc++; } } catch (e) { console.warn("[twse] tpex peQryDate failed:", e.message); }
          await sleep(300);
        }
      }
    }
    if (tse && otc) await writeCache("valuation", rows); // 兩邊都齊才快取，缺一邊下次再試
  }
  return Object.fromEntries(symbols.map((s) => [s, rows[s] || null]));
}

export async function getRevenue(symbols) {
  let rows = await readCache("revenue", 24 * 60 * 60 * 1000);
  if (!rows) {
    rows = {};
    for (const [url, mk] of [["https://openapi.twse.com.tw/v1/opendata/t187ap05_L", "tse"], ["https://openapi.twse.com.tw/v1/opendata/t187ap05_O", "otc"]]) {
      try {
        const j = await fetchJson(url);
        for (const r of j) rows[r["公司代號"]] = { month: r["資料年月"], industry: r["產業別"], revenue: num(r["營業收入-當月營收"]), mom: num(r["營業收入-上月比較增減(%)"]), yoy: num(r["營業收入-去年同月增減(%)"]), ytdYoy: num(r["累計營業收入-前期比較增減(%)"]), note: (r["備註"] || "").slice(0, 80) };
      } catch (e) { console.warn(`[twse] revenue ${mk} failed:`, e.message); }
    }
    if (Object.keys(rows).length) await writeCache("revenue", rows);
  }
  return Object.fromEntries(symbols.map((s) => [s, rows[s] || null]));
}
