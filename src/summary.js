// 投資委員會結論：把五位分析師與投資長決策整理成人看得懂的摘要
import { LABELS } from "./analysts/index.js";

const stanceOf = (s) => (s >= 0.8 ? "偏多" : s <= -0.8 ? "偏空" : "中性");
const fmtShares = (n) => (n >= 1000 && n % 1000 === 0 ? `${n / 1000} 張` : `${n} 股`);

export function buildSummary({ analyses, macro, decisions, ai, valuation, risk, marketOpen, advisors }) {
  const list = Object.values(analyses);
  const analysts = [];
  for (const id of ["technical", "fundamental", "chips", "macro", "sentiment", "advisor"]) {
    const fromAi = ai?.discussion?.find((d) => d.analyst === id);
    if (id === "advisor") {
      if (!advisors) { analysts.push({ id, label: LABELS[id], score: 0, stance: "中性", text: "投顧觀點尚未取得（本機請確認 yt-dlp；雲端要等本機排程推送字幕）" }); continue; }
      const m = advisors.market || {};
      const named = Object.entries(advisors.bySymbol || {}).map(([sym, v]) => `${analyses[sym]?.name || sym} ${v.score > 0 ? "+" : ""}${v.score}`);
      const text = fromAi?.summary || `${advisors.items.length} 集（${advisors.transcripts} 集有字幕）；大盤 ${m.score > 0 ? "+" : ""}${m.score ?? 0}${named.length ? "；點名 " + named.slice(0, 4).join("、") : "；未點名追蹤標的"}`;
      analysts.push({ id, label: LABELS[id], score: +(m.score ?? 0).toFixed(2), stance: fromAi?.stance_zh || stanceOf(m.score ?? 0), text });
      continue;
    }
    if (id === "macro") {
      analysts.push({ id, label: LABELS[id], score: macro?.score ?? 0, stance: fromAi?.stance_zh || stanceOf(macro?.score ?? 0), text: fromAi?.summary || `${macro?.data?.regime === "risk-off" ? "風險趨避" : macro?.data?.regime === "risk-on" ? "風險偏好" : "中性"}：${(macro?.points || []).slice(0, 3).join("；")}` });
      continue;
    }
    const scores = list.map((a) => ({ sym: a.symbol, name: a.name, s: a.analysts?.[id]?.score ?? 0 })).sort((x, y) => y.s - x.s);
    const avg = scores.length ? scores.reduce((t, x) => t + x.s, 0) / scores.length : 0;
    const bull = scores.filter((x) => x.s >= 0.8).length, bear = scores.filter((x) => x.s <= -0.8).length;
    const best = scores[0], worst = scores[scores.length - 1];
    const text = fromAi?.summary || `${list.length} 檔中 ${bull} 檔偏多、${bear} 檔偏空${best ? `；最看好 ${best.name} (${best.s > 0 ? "+" : ""}${best.s})` : ""}${worst && worst !== best ? `，最弱 ${worst.name} (${worst.s})` : ""}`;
    analysts.push({ id, label: LABELS[id], score: +avg.toFixed(2), stance: fromAi?.stance_zh || stanceOf(avg), text });
  }

  const acts = decisions.filter((d) => d.action !== "HOLD" && d.shares > 0).map((d) => {
    const a = analyses[d.symbol] || {};
    return { symbol: d.symbol, name: a.name, action: d.action, shares: d.shares, sharesText: fmtShares(d.shares), price: a.price, amount: a.price ? Math.round(a.price * d.shares) : null, reason: d.reason, result: d.result || null };
  });
  const ranked = list.slice().sort((a, b) => b.score - a.score);
  const top = ranked[0];
  let conclusion = ai?.market_view || "";
  if (!conclusion) {
    const buys = decisions.filter((d) => d.action === "BUY").length, sells = decisions.filter((d) => d.action === "SELL").length;
    conclusion = `總經分析師判定${macro?.data?.regime === "risk-off" ? "風險趨避（risk-off）" : macro?.data?.regime === "risk-on" ? "風險偏好（risk-on）" : "中性環境"}。${list.length} 檔標的中 ${buys} 檔達買進門檻（≥ ${risk.buyThreshold}）、${sells} 檔觸發賣出，其餘觀望。` + (top ? `綜合分數最高為 ${top.name} (${top.score})，最低為 ${ranked[ranked.length - 1].name} (${ranked[ranked.length - 1].score})。` : "");
  }
  let actionPlan = ai?.action_plan || "";
  if (!actionPlan) {
    if (acts.length) actionPlan = acts.map((x) => `${x.action === "BUY" ? "買進" : "賣出"} ${x.symbol} ${x.name} ${x.sharesText}${x.amount ? `（約 ${x.amount.toLocaleString()} 元）` : ""}`).join("；") + "。";
    else actionPlan = `本輪不進出，全數觀望。${top && top.score > 0 ? `優先觀察 ${top.name}：綜合分數 ${top.score}，若升至 ${risk.buyThreshold} 以上且大盤轉強再進場。` : "等待總經轉為中性以上、技術面出現止跌訊號後再評估進場。"}`;
  }
  return { analysts, conclusion, actionPlan, actions: acts, source: ai ? ai.model : "規則引擎（投資長加權）", marketOpen, cash: valuation?.cash, total: valuation?.total };
}
