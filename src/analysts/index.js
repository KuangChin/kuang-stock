// 投資長（PM）：彙整五位分析師的分數，加權成 -8 ~ +8 的綜合分數
import * as technical from "./technical.js";
import * as fundamental from "./fundamental.js";
import * as chips from "./chips.js";
import * as macro from "./macro.js";
import * as sentiment from "./sentiment.js";
import * as advisor from "./advisor.js";

export const ANALYSTS = { technical, fundamental, chips, macro, sentiment, advisor };
export const DEFAULT_WEIGHTS = Object.fromEntries(Object.values(ANALYSTS).map((a) => [a.id, a.defaultWeight]));
export const LABELS = Object.fromEntries(Object.values(ANALYSTS).map((a) => [a.id, a.label]));

/**
 * results: {technical:{score,confidence,points}, ...}（缺的分析師會被跳過並重新正規化權重）
 * 回傳 {score(-8..8), reasons, breakdown}
 */
export function combine(results, weights = DEFAULT_WEIGHTS) {
  let wsum = 0, acc = 0;
  const breakdown = {};
  for (const [id, r] of Object.entries(results)) {
    if (!r) continue;
    const w = weights[id] ?? DEFAULT_WEIGHTS[id] ?? 0;
    if (!w) continue;
    wsum += w; acc += w * r.score;
    breakdown[id] = { score: r.score, confidence: r.confidence, weight: w, label: LABELS[id], points: r.points, data: r.data };
  }
  const score = wsum ? +((acc / wsum) * 4).toFixed(1) : 0;
  const reasons = Object.entries(breakdown)
    .sort((a, b) => Math.abs(b[1].score * b[1].weight) - Math.abs(a[1].score * a[1].weight))
    .flatMap(([id, b]) => b.points.slice(0, 2).map((p) => `[${b.label}] ${p}`));
  return { score, reasons, breakdown };
}

/** 對單一標的跑所有分析師（macroResult 由呼叫端先算一次傳入） */
export function analyzeSymbol(ctx, macroResult, weights) {
  const results = {
    technical: technical.analyze(ctx),
    fundamental: fundamental.analyze(ctx),
    chips: chips.analyze(ctx),
    macro: macroResult,
    sentiment: sentiment.analyze(ctx),
    advisor: advisor.analyze(ctx),
  };
  return combine(results, weights);
}
