// 總經分析師：台股指數、美股、費半、VIX、匯率、利率、總經新聞（市場層級，對所有標的相同）
export const id = "macro";
export const label = "總經";
export const defaultWeight = 0.15;
const clip = (v) => Math.max(-2, Math.min(2, v));

export function analyzeMarket({ indices = {}, global = {}, taifex = null, macroSentiment = 0 }) {
  const pts = []; let s = 0, conf = 0.3;
  const tx = indices.taiex;
  if (tx?.changePct != null) {
    conf += 0.2;
    if (tx.changePct <= -2) { s -= 1; pts.push(`加權指數重挫 ${tx.changePct}%`); }
    else if (tx.changePct <= -0.8) { s -= 0.4; pts.push(`加權指數下跌 ${tx.changePct}%`); }
    else if (tx.changePct >= 1.5) { s += 0.6; pts.push(`加權指數大漲 +${tx.changePct}%`); }
    else if (tx.changePct >= 0.5) { s += 0.3; pts.push(`加權指數上漲 +${tx.changePct}%`); }
  }
  const g = global;
  if (g.sox) { conf += 0.2; if (g.sox.changePct <= -2) { s -= 0.6; pts.push(`費城半導體 ${g.sox.changePct}%`); } else if (g.sox.changePct >= 1.5) { s += 0.5; pts.push(`費城半導體 +${g.sox.changePct}%`); } if (g.sox.ret5 != null && g.sox.ret5 <= -5) { s -= 0.4; pts.push(`費半近 5 日 ${g.sox.ret5}%`); } else if (g.sox.ret5 >= 5) { s += 0.3; pts.push(`費半近 5 日 +${g.sox.ret5}%`); } }
  if (g.sp500) { if (g.sp500.changePct <= -1.5) { s -= 0.4; pts.push(`S&P 500 ${g.sp500.changePct}%`); } else if (g.sp500.changePct >= 1) { s += 0.3; pts.push(`S&P 500 +${g.sp500.changePct}%`); } }
  if (g.vix) { conf += 0.1; if (g.vix.price >= 30) { s -= 1; pts.push(`VIX ${g.vix.price} 恐慌區`); } else if (g.vix.price >= 22) { s -= 0.5; pts.push(`VIX ${g.vix.price} 偏高`); } else if (g.vix.price <= 15) { s += 0.3; pts.push(`VIX ${g.vix.price} 低波動`); } else pts.push(`VIX ${g.vix.price}`); }
  if (g.usdtwd?.ret5 != null) { if (g.usdtwd.ret5 >= 1) { s -= 0.3; pts.push(`台幣近 5 日貶 ${g.usdtwd.ret5}%（外資偏流出）`); } else if (g.usdtwd.ret5 <= -1) { s += 0.3; pts.push(`台幣近 5 日升 ${(-g.usdtwd.ret5).toFixed(2)}%（外資偏流入）`); } }
  if (g.us10y?.price != null) pts.push(`美債 10 年期殖利率 ${g.us10y.price.toFixed(2)}%`);
  // 臺指期夜盤／日盤：對結算價的漲跌，是下一個交易日開盤最直接的領先指標
  const tf = taifex?.latest;
  if (tf?.changePct != null) {
    conf += 0.15;
    const lab = tf.session === "night" ? "台指夜盤" : "台指期";
    if (tf.changePct >= 1) { s += 0.6; pts.push(`${lab} +${tf.changePct}%（${tf.price}，期現價差 ${tf.basis > 0 ? "+" : ""}${tf.basis}）`); }
    else if (tf.changePct >= 0.4) { s += 0.3; pts.push(`${lab} +${tf.changePct}%`); }
    else if (tf.changePct <= -1) { s -= 0.6; pts.push(`${lab} ${tf.changePct}%（${tf.price}，期現價差 ${tf.basis > 0 ? "+" : ""}${tf.basis}）`); }
    else if (tf.changePct <= -0.4) { s -= 0.3; pts.push(`${lab} ${tf.changePct}%`); }
    else pts.push(`${lab} ${tf.changePct > 0 ? "+" : ""}${tf.changePct}%`);
  }
  // 美股期貨（近乎 24 小時交易）：盤後／夜間方向
  const fut = [g.es, g.nq].filter((x) => x?.changePct != null);
  if (fut.length) {
    const avg = fut.reduce((t, x) => t + x.changePct, 0) / fut.length;
    const txt = fut.map((x) => `${x.label} ${x.changePct > 0 ? "+" : ""}${x.changePct}%`).join("、");
    if (avg >= 0.8) { s += 0.3; pts.push(`美股期貨走強：${txt}`); } else if (avg <= -0.8) { s -= 0.3; pts.push(`美股期貨走弱：${txt}`); } else pts.push(`美股期貨 ${txt}`);
  }
  // 台積電 ADR 與美國半導體股（含盤前盤後）
  if (g.tsm?.changePct != null) {
    const ses = { pre: "盤前", post: "盤後", regular: "盤中", closed: "收盤" }[g.tsm.session] || "";
    if (g.tsm.changePct >= 2) { s += 0.4; pts.push(`台積電 ADR ${ses} +${g.tsm.changePct}%`); } else if (g.tsm.changePct <= -2) { s -= 0.4; pts.push(`台積電 ADR ${ses} ${g.tsm.changePct}%`); } else pts.push(`台積電 ADR ${ses} ${g.tsm.changePct > 0 ? "+" : ""}${g.tsm.changePct}%`);
  }
  const chips = ["nvda", "amd", "mu", "avgo"].map((k) => g[k]).filter((x) => x?.changePct != null);
  if (chips.length) {
    const avg = chips.reduce((t, x) => t + x.changePct, 0) / chips.length;
    const txt = chips.map((x) => `${x.label} ${x.changePct > 0 ? "+" : ""}${x.changePct}%`).join("、");
    if (avg >= 2) { s += 0.3; pts.push(`美國半導體股強勢：${txt}`); } else if (avg <= -2) { s -= 0.3; pts.push(`美國半導體股疲弱：${txt}`); } else pts.push(`美國半導體股 ${txt}`);
  }
  if (macroSentiment <= -0.3) { s -= 0.5; pts.push(`總經新聞偏空 (${macroSentiment})`); } else if (macroSentiment >= 0.3) { s += 0.5; pts.push(`總經新聞偏多 (${macroSentiment})`); }
  const score = +clip(s).toFixed(2);
  const regime = score <= -1 ? "risk-off" : score >= 0.8 ? "risk-on" : "neutral";
  return { score, confidence: +Math.min(1, conf).toFixed(2), points: pts, data: { regime, taiex: tx?.price, taiexChangePct: tx?.changePct, sox: g.sox?.price, soxChangePct: g.sox?.changePct, sp500ChangePct: g.sp500?.changePct, nasdaqChangePct: g.nasdaq?.changePct, vix: g.vix?.price, usdtwd: g.usdtwd?.price, us10y: g.us10y?.price, taifexPct: tf?.changePct ?? null, taifexSession: tf?.session ?? null, esPct: g.es?.changePct ?? null, nqPct: g.nq?.changePct ?? null, tsmPct: g.tsm?.changePct ?? null } };
}
