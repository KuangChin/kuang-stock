// 情緒分析師：個股新聞情緒、新聞量、總經新聞情緒、VIX、技術面極端值（反向）
export const id = "sentiment";
export const label = "情緒";
export const defaultWeight = 0.15;
const clip = (v) => Math.max(-2, Math.min(2, v));

export function analyze({ news = [], sentiment, macroSentiment = 0, global = {}, ind }) {
  const pts = []; let s = 0, conf = 0.2;
  const n = sentiment?.n || 0, sc = sentiment?.score || 0;
  if (n) {
    conf += Math.min(0.5, n * 0.06);
    s += sc * 2;
    pts.push(`個股新聞情緒 ${sc > 0 ? "+" : ""}${sc}（${n} 則）`);
    const recent = news.filter((x) => x.pubDate && Date.now() - new Date(x.pubDate) < 24 * 3600e3).length;
    if (recent >= 5) pts.push(`24 小時內 ${recent} 則報導，關注度高`);
    const strong = news.filter((x) => Math.abs(x.sentiment) >= 1);
    for (const x of strong.slice(0, 2)) pts.push(`${x.sentiment > 0 ? "▲" : "▼"} ${x.title}`);
  } else pts.push("近期無相關新聞");
  if (macroSentiment) { s += macroSentiment * 0.5; pts.push(`市場新聞情緒 ${macroSentiment > 0 ? "+" : ""}${macroSentiment}`); }
  if (global.vix?.price >= 25) { s -= 0.3; pts.push("VIX 偏高，市場恐慌"); }
  const L = ind?.latest;
  if (L?.rsi14 != null && L.rsi14 < 25) { s += 0.4; pts.push("技術面極度超賣，情緒過度悲觀（反向）"); }
  if (L?.rsi14 != null && L.rsi14 > 80) { s -= 0.4; pts.push("技術面極度超買，情緒過熱（反向）"); }
  return { score: +clip(s).toFixed(2), confidence: +Math.min(1, conf).toFixed(2), points: pts, data: { newsScore: sc, newsCount: n, macroSentiment, vix: global.vix?.price } };
}
