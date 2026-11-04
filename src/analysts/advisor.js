// 投顧分析師：把投顧老師（YouTube / Podcast）最近一週的看法變成分數。
// 個股有被點名 → 用整理後的個股分數；沒被點名 → 只帶入大盤看法的一半；完全沒資料 → 跳過（不參與加權）。
export const id = "advisor";
export const label = "投顧";
export const defaultWeight = 0.15;
const clip = (v) => Math.max(-2, Math.min(2, v));

export function analyze({ advisor, advisorMarket }) {
  if (!advisor && !advisorMarket) return null;
  if (advisor) {
    return { score: +clip(advisor.score).toFixed(2), confidence: +Math.min(1, advisor.confidence ?? 0.5).toFixed(2), points: (advisor.points || []).slice(0, 4), data: { mentioned: true } };
  }
  const m = advisorMarket;
  const pts = [`投顧近一週未點名此股；大盤看法 ${m.score > 0 ? "+" : ""}${m.score}`, ...(m.points || []).slice(0, 2)];
  return { score: +clip(m.score * 0.5).toFixed(2), confidence: 0.25, points: pts, data: { mentioned: false, marketScore: m.score } };
}
