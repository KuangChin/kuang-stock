// 技術線型分析師：均線、動能、KD、量價、突破
export const id = "technical";
export const label = "技術線型";
export const defaultWeight = 0.35;
const clip = (v) => Math.max(-2, Math.min(2, v));

export function analyze({ ind, quote }) {
  const L = ind?.latest;
  if (!L) return { score: 0, confidence: 0.1, points: ["歷史資料不足"], data: {} };
  const price = quote?.price ?? L.close;
  const pts = []; let s = 0;
  if (L.ma20 && L.ma60) {
    if (price > L.ma20 && L.ma20 > L.ma60) { s += 2; pts.push("多頭排列：價 > MA20 > MA60"); }
    else if (price < L.ma20 && L.ma20 < L.ma60) { s -= 2; pts.push("空頭排列：價 < MA20 < MA60"); }
    else if (price > L.ma20) { s += 1; pts.push("價格站上 MA20"); }
    else { s -= 1; pts.push("價格跌破 MA20"); }
  }
  if (L.ma20Slope != null) { if (L.ma20Slope > 1) { s += 0.5; pts.push(`MA20 上彎 (${L.ma20Slope}%)`); } else if (L.ma20Slope < -1) { s -= 0.5; pts.push(`MA20 下彎 (${L.ma20Slope}%)`); } }
  if (L.ma5x20 === 1) { s += 1; pts.push("MA5 黃金交叉 MA20"); }
  if (L.ma5x20 === -1) { s -= 1; pts.push("MA5 死亡交叉 MA20"); }
  if (L.macdHist != null && L.macdHistPrev != null) {
    if (L.macdHist > 0 && L.macdHist > L.macdHistPrev) { s += 1; pts.push("MACD 柱狀體翻正且擴大"); }
    else if (L.macdHist < 0 && L.macdHist < L.macdHistPrev) { s -= 1; pts.push("MACD 柱狀體轉負且擴大"); }
  }
  if (L.rsi14 != null) { if (L.rsi14 < 30) { s += 1; pts.push(`RSI 超賣 (${L.rsi14})`); } else if (L.rsi14 > 75) { s -= 1; pts.push(`RSI 超買 (${L.rsi14})`); } }
  if (L.k != null) {
    if (L.k < 25 && L.kdCross === 1) { s += 1.5; pts.push("KD 低檔黃金交叉"); }
    else if (L.k > 80 && L.kdCross === -1) { s -= 1.5; pts.push("KD 高檔死亡交叉"); }
    else if (L.k < 20) { s += 0.5; pts.push(`KD 低檔 (K=${L.k})`); }
    else if (L.k > 85) { s -= 0.5; pts.push(`KD 高檔 (K=${L.k})`); }
  }
  if (L.volRatio != null && L.volRatio > 1.5 && quote?.changePct != null) {
    if (quote.changePct > 0) { s += 1; pts.push(`量增價漲 (量比 ${L.volRatio})`); }
    else if (quote.changePct < -2) { s -= 1; pts.push(`量增價跌 (量比 ${L.volRatio})`); }
  }
  if (L.hi20 && price >= L.hi20 * 0.999) { s += 0.5; pts.push("突破 20 日高點"); }
  if (L.lo20 && price <= L.lo20 * 1.001) { s -= 0.5; pts.push("跌破 20 日低點"); }
  if (L.bbPos != null && L.bbPos < 5) pts.push("觸及布林下軌");
  if (L.bbPos != null && L.bbPos > 95) pts.push("觸及布林上軌");
  const confidence = Math.min(1, 0.4 + (L.bars || 0) / 200);
  return { score: +clip(s / 4).toFixed(2), confidence: +confidence.toFixed(2), points: pts, data: { rsi14: L.rsi14, k: L.k, d: L.d, ma20: L.ma20, ma60: L.ma60, macdHist: L.macdHist, volRatio: L.volRatio, atrPct: L.atrPct } };
}
