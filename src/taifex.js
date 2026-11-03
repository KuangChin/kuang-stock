// 期交所即時報價（mis.taifex.com.tw，無需金鑰）：臺指期日盤 / 夜盤近月合約
// 夜盤 15:00–次日 05:00，日盤 08:45–13:45。夜盤漲跌以日盤結算價（CRefPrice）為基準。
const URL = "https://mis.taifex.com.tw/futures/api/getQuoteList";
const num = (s) => { const v = parseFloat(String(s ?? "").replace(/,/g, "")); return Number.isFinite(v) ? v : null; };
let cache = { t: 0, data: null };

async function quoteList(marketType) {
  const r = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    body: JSON.stringify({ MarketType: marketType, SymbolType: "F", KindID: "1", CID: "TXF", ExpireMonth: "", RowSize: "全部", PageNo: "", SortColumn: "", AscDesc: "A" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`taifex HTTP ${r.status}`);
  const j = await r.json();
  if (j.RtCode !== "0") throw new Error(`taifex ${j.RtMsg || j.RtCode}`);
  return j.RtData?.QuoteList || [];
}

function pick(list, session) {
  const spot = list.find((q) => q.SymbolID === "TXF-P" || q.SymbolID === "TXF-S");
  const near = list.find((q) => /^TXF[A-Z]\d-M$/.test(q.SymbolID) && num(q.CLastPrice));
  if (!near) return { spot: num(spot?.CLastPrice) ?? num(spot?.CRefPrice), contract: null };
  const price = num(near.CLastPrice), ref = num(near.CRefPrice);
  const t = near.CTime && near.CTime.length === 6 ? `${near.CTime.slice(0, 2)}:${near.CTime.slice(2, 4)}` : null;
  const spotPrice = num(spot?.CLastPrice) ?? num(spot?.CRefPrice);
  return {
    spot: spotPrice,
    contract: {
      session, symbol: near.SymbolID, name: near.DispCName, price, ref,
      change: price != null && ref != null ? +(price - ref).toFixed(0) : null,
      changePct: price != null && ref ? +(((price - ref) / ref) * 100).toFixed(2) : null,
      open: num(near.COpenPrice), high: num(near.CHighPrice), low: num(near.CLowPrice), volume: num(near.CTotalVolume),
      basis: price != null && spotPrice != null ? +(price - spotPrice).toFixed(0) : null, // 期現價差
      date: near.CDate, time: t,
    },
  };
}

/** 回 { spot, day, night, latest } ；latest = 目前有在交易或最近一個時段的合約 */
export async function getTaifex() {
  if (cache.data && Date.now() - cache.t < 3 * 60 * 1000) return cache.data;
  const [dayList, nightList] = await Promise.all([quoteList("0").catch(() => []), quoteList("1").catch(() => [])]);
  const day = pick(dayList, "day"), night = pick(nightList, "night");
  const tw = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const mins = tw.getHours() * 60 + tw.getMinutes();
  const dayHours = mins >= 8 * 60 + 45 && mins <= 13 * 60 + 50;
  const out = { spot: day.spot ?? night.spot, day: day.contract, night: night.contract, latest: dayHours ? day.contract || night.contract : night.contract || day.contract };
  cache = { t: Date.now(), data: out };
  return out;
}
