// 規則型決策：依綜合分數（由 analysts/index.js 的投資長產生，-8 ~ +8）與風控參數產生買賣清單

export const DEFAULT_RISK = {
  maxPositionPct: 0.25,   // 單一持股占總資產上限
  perTradePct: 0.15,      // 每次買進動用總資產比例
  stopLossPct: 0.08,      // 停損
  takeProfitPct: 0.25,    // 停利（減碼一半）
  minCashPct: 0.05,       // 保留現金比例
  buyThreshold: 3,
  sellThreshold: -3,
  oddLot: true,           // 現金不足一張時允許零股
  maxPositions: 8,
  cooldownDays: 5,        // 同一檔買進後 N 天內不再加碼
  minOrderAmount: 20000,  // 最小下單金額（元）
};

/**
 * 產生決策清單。
 * positions: {symbol:{shares,avgCost}}; analyses: {symbol:{score,reasons,price,quote}}
 */
/**
 * margin：{ enabled, ratio: {symbol: 成數}, maintenance（倍數，如 1.3）, forceSell, currentRatio（整戶維持率 %，null 表示沒有融資） }
 * 開啟融資時，買進決策帶 margin:true（整張）；現金只需自備款。維持率低於追繳線且 forceSell 時，先斷頭虧最多的融資持股。
 */
export function decide({ analyses, positions, cash, totalEquity, risk = DEFAULT_RISK, lastBuyDays = {}, margin = null }) {
  risk = { ...DEFAULT_RISK, ...risk };
  const decisions = [];
  const held = Object.keys(positions).filter((s) => positions[s].shares > 0);
  const useMargin = Boolean(margin?.enabled);

  // 融資追繳：整戶維持率低於門檻就斷頭虧最多的那檔（模擬券商處分）
  const forced = new Set();
  if (margin?.currentRatio != null && margin.forceSell && margin.currentRatio < (margin.maintenance || 1.3) * 100) {
    const worst = held.filter((s) => positions[s].loan > 0 && analyses[s]?.price).sort((a, b) => (analyses[a].price / positions[a].avgCost) - (analyses[b].price / positions[b].avgCost))[0];
    if (worst) {
      const pnlPct = ((analyses[worst].price - positions[worst].avgCost) / positions[worst].avgCost) * 100;
      decisions.push({ symbol: worst, action: "SELL", shares: positions[worst].shares, reason: `斷頭：整戶維持率 ${margin.currentRatio}% 低於 ${Math.round((margin.maintenance || 1.3) * 100)}%，處分虧損最大的融資持股（${pnlPct.toFixed(1)}%）`, score: analyses[worst].score, kind: "margincall" });
      forced.add(worst);
    }
  }

  // 先處理持股：停損 / 停利 / 賣出訊號
  for (const sym of held) {
    if (forced.has(sym)) continue;
    const a = analyses[sym];
    if (!a || a.price == null) continue;
    const pos = positions[sym];
    const pnlPct = (a.price - pos.avgCost) / pos.avgCost;
    if (pnlPct <= -risk.stopLossPct) {
      decisions.push({ symbol: sym, action: "SELL", shares: pos.shares, reason: `停損：損益 ${(pnlPct * 100).toFixed(1)}%`, score: a.score, kind: "stop" });
      continue;
    }
    if (pnlPct >= risk.takeProfitPct && a.score < risk.buyThreshold) {
      let half = Math.floor(pos.shares / 2 / 1000) * 1000;
      if (half === 0) half = Math.floor(pos.shares / 2);
      if (half === 0) half = pos.shares;
      decisions.push({ symbol: sym, action: "SELL", shares: half, reason: `停利減碼一半：損益 +${(pnlPct * 100).toFixed(1)}%`, score: a.score, kind: "take" });
      continue;
    }
    if (a.score <= risk.sellThreshold) {
      decisions.push({ symbol: sym, action: "SELL", shares: pos.shares, reason: `訊號轉空 (分數 ${a.score})：${a.reasons.slice(0, 3).join("；")}`, score: a.score, kind: "signal" });
      continue;
    }
    decisions.push({ symbol: sym, action: "HOLD", shares: 0, reason: `續抱 (分數 ${a.score})`, score: a.score, kind: "hold" });
  }

  // 買進候選：依分數排序
  const candidates = Object.entries(analyses)
    .filter(([sym, a]) => a.score >= risk.buyThreshold && a.price > 0)
    .sort((a, b) => b[1].score - a[1].score);
  let cashLeft = cash;
  const minCash = totalEquity * risk.minCashPct;
  let positionCount = held.length;
  for (const [sym, a] of candidates) {
    const pos = positions[sym];
    const curValue = pos ? pos.shares * a.price : 0;
    const maxValue = totalEquity * risk.maxPositionPct;
    const room = maxValue - curValue;
    if (room <= 0) { decisions.push({ symbol: sym, action: "HOLD", shares: 0, reason: `已達單一持股上限 (分數 ${a.score})`, score: a.score, kind: "cap" }); continue; }
    if (!pos && positionCount >= risk.maxPositions) { decisions.push({ symbol: sym, action: "HOLD", shares: 0, reason: "已達持股檔數上限", score: a.score, kind: "cap" }); continue; }
    if (lastBuyDays[sym] != null && lastBuyDays[sym] < risk.cooldownDays) { decisions.push({ symbol: sym, action: "HOLD", shares: 0, reason: `冷卻中：${lastBuyDays[sym]} 天前剛買進 (分數 ${a.score})`, score: a.score, kind: "cooldown" }); continue; }
    // 融資：同樣的曝險，現金只要付自備款（1 − 成數）
    const ratio = useMargin ? margin.ratio?.[sym] || 0 : 0;
    const cashRoom = cashLeft - minCash;
    const budget = Math.min(totalEquity * risk.perTradePct, room, ratio ? cashRoom / (1 - ratio) : cashRoom);
    if (budget <= 0) { decisions.push({ symbol: sym, action: "HOLD", shares: 0, reason: `現金不足 (分數 ${a.score})`, score: a.score, kind: "cash" }); continue; }
    let shares = Math.floor(budget / (a.price * 1000)) * 1000;
    let onMargin = ratio > 0 && shares > 0; // 融資只能整張；不足一張就退回現股零股
    if (shares === 0 && risk.oddLot) shares = Math.floor(Math.min(budget, cashRoom) / a.price);
    if (shares <= 0 || shares * a.price < risk.minOrderAmount) { decisions.push({ symbol: sym, action: "HOLD", shares: 0, reason: `預算低於最小下單金額 (分數 ${a.score})`, score: a.score, kind: "cash" }); continue; }
    const cost = shares * a.price * 1.001425 - (onMargin ? Math.floor((shares * a.price * ratio) / 1000) * 1000 : 0);
    cashLeft -= cost;
    if (!pos) positionCount++;
    decisions.push({ symbol: sym, action: "BUY", shares, margin: onMargin, reason: `訊號偏多 (分數 ${a.score})${onMargin ? `，融資 ${Math.round(ratio * 100)}%` : ""}：${a.reasons.slice(0, 3).join("；")}`, score: a.score, kind: "signal" });
  }
  // 未進入上述者
  for (const [sym, a] of Object.entries(analyses)) {
    if (!decisions.find((d) => d.symbol === sym)) decisions.push({ symbol: sym, action: "HOLD", shares: 0, reason: `觀望 (分數 ${a.score})`, score: a.score, kind: "watch" });
  }
  return decisions;
}
