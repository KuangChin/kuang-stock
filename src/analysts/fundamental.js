// 基本面分析師：本益比、淨值比、殖利率、月營收動能
export const id = "fundamental";
export const label = "基本面";
export const defaultWeight = 0.15;
const clip = (v) => Math.max(-2, Math.min(2, v));

export function analyze({ valuation: v, revenue: r, symbol }) {
  const pts = []; let s = 0, conf = 0.3;
  if (!v && !r) return { score: 0, confidence: 0.1, points: [/^00/.test(symbol) ? "ETF 無個股基本面資料，中性" : "查無基本面資料"], data: {} };
  if (r) {
    conf += 0.3;
    if (r.yoy != null) {
      if (r.yoy >= 30) { s += 1.2; pts.push(`月營收年增 +${r.yoy.toFixed(1)}%`); }
      else if (r.yoy >= 10) { s += 0.7; pts.push(`月營收年增 +${r.yoy.toFixed(1)}%`); }
      else if (r.yoy >= 0) { s += 0.2; pts.push(`月營收年增 +${r.yoy.toFixed(1)}%`); }
      else if (r.yoy >= -10) { s -= 0.4; pts.push(`月營收年減 ${r.yoy.toFixed(1)}%`); }
      else { s -= 1; pts.push(`月營收年減 ${r.yoy.toFixed(1)}%`); }
    }
    if (r.mom != null) { if (r.mom >= 15) { s += 0.3; pts.push(`月增 +${r.mom.toFixed(1)}%`); } else if (r.mom <= -15) { s -= 0.3; pts.push(`月減 ${r.mom.toFixed(1)}%`); } }
    if (r.ytdYoy != null) { if (r.ytdYoy >= 20) { s += 0.3; pts.push(`累計營收年增 +${r.ytdYoy.toFixed(1)}%`); } else if (r.ytdYoy < 0) { s -= 0.3; pts.push(`累計營收年減 ${r.ytdYoy.toFixed(1)}%`); } }
    if (r.note) pts.push(`公司說明：${r.note}`);
  }
  if (v) {
    conf += 0.3;
    const growth = r?.yoy ?? 0;
    if (v.pe != null) {
      if (v.pe <= 0) { s -= 0.5; pts.push("本益比為負（虧損）"); }
      else if (v.pe < 12) { s += 0.5; pts.push(`本益比偏低 ${v.pe}`); }
      else if (v.pe > 35 && growth < 30) { s -= 0.6; pts.push(`本益比偏高 ${v.pe}，營收成長不足以支撐`); }
      else if (v.pe > 35) pts.push(`本益比 ${v.pe}，高成長支撐`);
      else pts.push(`本益比 ${v.pe}`);
    }
    if (v.pb != null) { if (v.pb < 1) { s += 0.3; pts.push(`股價淨值比 ${v.pb} < 1`); } else if (v.pb > 8) { s -= 0.2; pts.push(`股價淨值比 ${v.pb} 偏高`); } }
    if (v.yield != null) { if (v.yield >= 5) { s += 0.5; pts.push(`殖利率 ${v.yield}%`); } else if (v.yield >= 3.5) { s += 0.2; pts.push(`殖利率 ${v.yield}%`); } else if (v.yield < 1) pts.push(`殖利率僅 ${v.yield}%`); }
  }
  return { score: +clip(s).toFixed(2), confidence: +Math.min(1, conf).toFixed(2), points: pts, data: { pe: v?.pe, pb: v?.pb, yield: v?.yield, revMonth: r?.month, revYoy: r?.yoy, revMom: r?.mom, revYtdYoy: r?.ytdYoy, industry: r?.industry } };
}
