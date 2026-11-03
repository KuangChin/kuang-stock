// 籌碼分析師：三大法人買賣超、連續性、相對成交量、融資融券
export const id = "chips";
export const label = "籌碼";
export const defaultWeight = 0.2;
const clip = (v) => Math.max(-2, Math.min(2, v));
const lots = (shares) => Math.round(shares / 1000);
const streak = (arr, key, sign) => { let n = 0; for (let i = arr.length - 1; i >= 0; i--) { if (Math.sign(arr[i][key] || 0) === sign) n++; else break; } return n; };

export function analyze({ insti = [], margin, ind }) {
  const pts = []; let s = 0, conf = 0.2;
  if (!insti.length && !margin) return { score: 0, confidence: 0.1, points: ["查無籌碼資料"], data: {} };
  const sum = (arr, k) => arr.reduce((a, b) => a + (b[k] || 0), 0);
  if (insti.length) {
    conf += Math.min(0.6, insti.length * 0.06);
    const n5 = insti.slice(-5), n10 = insti.slice(-10);
    const t5 = sum(n5, "total"), t10 = sum(n10, "total"), f5 = sum(n5, "foreign"), tr5 = sum(n5, "trust");
    const vol20 = (ind?.latest?.vol20 || 0) * 1000;
    const ratio = vol20 ? (t5 / (vol20 * 5)) * 100 : null;
    if (t5 > 0 && t10 > 0) { s += 1; pts.push(`三大法人近 5/10 日淨買 ${lots(t5)}/${lots(t10)} 張`); }
    else if (t5 < 0 && t10 < 0) { s -= 1; pts.push(`三大法人近 5/10 日淨賣 ${lots(-t5)}/${lots(-t10)} 張`); }
    else if (t5 > 0) { s += 0.4; pts.push(`法人近 5 日轉買 ${lots(t5)} 張`); }
    else if (t5 < 0) { s -= 0.4; pts.push(`法人近 5 日轉賣 ${lots(-t5)} 張`); }
    if (ratio != null) { if (ratio > 5) { s += 0.5; pts.push(`法人買超占成交量 ${ratio.toFixed(1)}%`); } else if (ratio < -5) { s -= 0.5; pts.push(`法人賣超占成交量 ${(-ratio).toFixed(1)}%`); } }
    const fb = streak(insti, "foreign", 1), fs = streak(insti, "foreign", -1), tb = streak(insti, "trust", 1), ts = streak(insti, "trust", -1);
    if (fb >= 3) { s += 0.4; pts.push(`外資連 ${fb} 日買超`); } if (fs >= 3) { s -= 0.4; pts.push(`外資連 ${fs} 日賣超`); }
    if (tb >= 3) { s += 0.4; pts.push(`投信連 ${tb} 日買超`); } if (ts >= 3) { s -= 0.3; pts.push(`投信連 ${ts} 日賣超`); }
    if (f5 < 0 && tr5 > 0) pts.push("外資賣、投信買：籌碼分歧");
    const last = insti[insti.length - 1];
    if (last) pts.push(`最近一日 (${last.date})：外資 ${lots(last.foreign)}、投信 ${lots(last.trust)}、自營 ${lots(last.dealer)} 張`);
  }
  if (margin && margin.marginToday != null && margin.marginPrev) {
    conf += 0.2;
    const chg = ((margin.marginToday - margin.marginPrev) / margin.marginPrev) * 100;
    const util = margin.marginLimit ? (margin.marginToday / margin.marginLimit) * 100 : null;
    if (chg >= 3) { s -= 0.3; pts.push(`融資餘額增 ${chg.toFixed(1)}%（散戶追價）`); }
    else if (chg <= -3) { s += 0.3; pts.push(`融資餘額減 ${(-chg).toFixed(1)}%（籌碼洗清）`); }
    if (util != null && util > 30) { s -= 0.2; pts.push(`融資使用率 ${util.toFixed(0)}% 偏高`); }
    if (margin.shortToday && margin.shortPrev && margin.shortToday > margin.shortPrev * 1.1) { s += 0.2; pts.push("融券增加，具軋空潛力"); }
  }
  return { score: +clip(s).toFixed(2), confidence: +Math.min(1, conf).toFixed(2), points: pts, data: { insti5: insti.length ? lots(sum(insti.slice(-5), "total")) : null, insti10: insti.length ? lots(sum(insti.slice(-10), "total")) : null, foreign5: insti.length ? lots(sum(insti.slice(-5), "foreign")) : null, trust5: insti.length ? lots(sum(insti.slice(-5), "trust")) : null, marginToday: margin?.marginToday, marginPrev: margin?.marginPrev, series: insti.map((d) => ({ date: d.date, total: lots(d.total), foreign: lots(d.foreign), trust: lots(d.trust) })) } };
}
