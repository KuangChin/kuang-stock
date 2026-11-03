// 新聞來源：Google 新聞 RSS（繁中/台灣），附簡易關鍵字情緒
const POS = ["漲", "創高", "新高", "利多", "成長", "看好", "增加", "突破", "反彈", "回升", "加碼", "買超", "大單", "強勢", "上修", "擴產", "訂單", "獲利", "佳", "樂觀", "升評", "目標價上調", "超預期", "紅盤", "站上", "攻", "創新高", "轉強", "回補", "降息"];
const NEG = ["跌", "利空", "下修", "衰退", "看壞", "賣超", "失守", "重挫", "崩", "減少", "虧損", "裁員", "關稅", "暴跌", "疲弱", "下跌", "悲觀", "降評", "目標價下調", "不如預期", "黑盤", "跌破", "轉弱", "賣壓", "升息", "制裁", "缺貨", "停工", "警訊", "風險", "拋售", "恐慌"];

const cache = new Map();

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

export function scoreHeadline(title) {
  let s = 0;
  for (const w of POS) if (title.includes(w)) s += 1;
  for (const w of NEG) if (title.includes(w)) s -= 1;
  return Math.max(-1, Math.min(1, s / 2));
}

export async function fetchNews(query, { limit = 12, ttlMs = 15 * 60 * 1000 } = {}) {
  const key = query + "|" + limit;
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttlMs) return c.items;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  let xml = "";
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    xml = await r.text();
  } catch (e) {
    console.warn("[news] fetch failed:", query, e.message);
    return c?.items || [];
  }
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const get = (tag) => decode((block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [, ""])[1]);
    let title = get("title");
    const source = get("source");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const pub = get("pubDate");
    if (items.some((x) => x.title === title)) continue;
    items.push({ title, link: get("link"), source, pubDate: pub ? new Date(pub).toISOString() : null, sentiment: scoreHeadline(title), query });
    if (items.length >= limit) break;
  }
  cache.set(key, { t: Date.now(), items });
  return items;
}

export function aggregateSentiment(items, { halfLifeHours = 24 } = {}) {
  if (!items.length) return { score: 0, n: 0 };
  let ws = 0, wt = 0;
  const now = Date.now();
  for (const it of items) {
    const age = it.pubDate ? (now - new Date(it.pubDate).getTime()) / 3600e3 : 48;
    const w = Math.pow(0.5, Math.max(age, 0) / halfLifeHours);
    ws += it.sentiment * w; wt += w;
  }
  return { score: wt ? +(ws / wt).toFixed(2) : 0, n: items.length };
}

/** 個股新聞 + 總經/世界新聞 */
export async function gatherNews(symbolNames, { perSymbol = 8 } = {}) {
  const out = { bySymbol: {}, macro: [] };
  for (const [symbol, name] of Object.entries(symbolNames)) {
    out.bySymbol[symbol] = await fetchNews(`${name} ${symbol}`, { limit: perSymbol });
  }
  const macroQueries = ["台股 大盤", "美股 聯準會 利率", "半導體 關稅 出口管制"];
  for (const q of macroQueries) out.macro.push(...(await fetchNews(q, { limit: 6 })));
  out.macro.sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""));
  return out;
}
