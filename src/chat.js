// 投資長對話：以最近一輪分析（state.lastCycle）與帳戶狀態為背景，用 Claude 串流回答。
// 背景放在 system 並設 cache_control，同一輪分析內多次對話只付一次完整輸入費。
import { loadEnv } from "./env.js";
import { valuation } from "./portfolio.js";
import { taipeiNow, isMarketOpen } from "./twse.js";
import { getTaifex } from "./taifex.js";
import { getGlobalMarkets } from "./yahoo.js";

export const CHAT_MAX = 40; // 保留的對話則數
const sign = (v, d = 1) => (v == null ? "--" : (v > 0 ? "+" : "") + Number(v).toFixed(d));

const SYSTEM = `你是「投資長」，主持一個台股模擬交易帳戶的投資委員會，底下有技術線型、基本面、籌碼、總經、情緒五位分析師。
你正在和帳戶主人對話。原則：
1. 回答依據背景資料裡的分析、持股、新聞與風控參數；資料沒有的事要明說「資料裡沒有」，不要編造數字。
2. 用繁體中文、台灣用語，口吻像一位務實的投資長：直接、具體、講理由，不說教，不免責聲明連篇。
3. 這是模擬帳戶，你不能直接下單；若建議操作，說清楚標的、方向、股數或比例、觸發條件，請對方在頁面按「分析並模擬下單」或手動下單。
4. 回答長度看問題：閒聊或簡單問題兩三句就好；分析類問題用短段落或條列，不要超過 300 字，除非對方要求詳細。
5. 可以表達不同意委員會先前的結論，但要說明新理由。
6. 停損、停利等風控數字一律以背景資料「風控」那一行為準（那是帳戶主人自己設的），不要引用其他比例；「保留現金」是現金比例，不是停損。`;

/** 把最近一輪分析整理成給投資長看的背景（文字；同一輪內不變，利於快取） */
export function buildContext(state) {
  const lc = state.lastCycle;
  const L = [];
  const quotes = {};
  if (lc?.analyses) for (const [s, a] of Object.entries(lc.analyses)) quotes[s] = { price: a.price, name: a.name };
  const val = valuation(state, quotes);
  L.push(`# 帳戶`);
  L.push(`起始資產 ${state.initialEquity}；現金 ${val.cash}；持股市值 ${val.marketValue}；總資產 ${val.total}；累積報酬 ${sign(val.returnPct, 2)}%。`);
  for (const r of val.rows) L.push(`- ${r.symbol} ${r.name}：${r.shares} 股，成本 ${r.avgCost}，現價 ${r.price}，損益 ${sign(r.pnl, 0)}（${sign(r.pnlPct, 2)}%）`);
  if (!val.rows.length) L.push(`- 無持股`);
  const rk = state.config.risk;
  L.push(`風控：停損 ${rk.stopLossPct * 100}%、停利 ${rk.takeProfitPct * 100}%（減半）、單一持股上限 ${rk.maxPositionPct * 100}%、每筆 ${rk.perTradePct * 100}%、保留現金 ${rk.minCashPct * 100}%、買進門檻 ${rk.buyThreshold}、賣出門檻 ${rk.sellThreshold}、冷卻 ${rk.cooldownDays} 天、最多 ${rk.maxPositions} 檔。`);
  L.push(`自動執行：${state.config.auto.enabled ? `開（盤中每 ${state.config.auto.intervalMin} 分鐘${state.config.auto.executeOnClose ? "，收盤後一次" : ""}）` : "關"}；AI 分析師：${state.config.ai.enabled ? "開" : "關"}。`);
  const trades = state.trades.slice(0, 8);
  if (trades.length) { L.push(`最近交易：`); for (const t of trades) L.push(`- ${t.t.slice(0, 16).replace("T", " ")} ${t.side} ${t.symbol} ${t.name} ${t.shares} 股 @ ${t.price}（${t.source}）${t.reason ? "：" + t.reason : ""}`); }

  if (!lc) { L.push(`\n# 尚未執行過分析，沒有委員會資料。`); return L.join("\n"); }
  L.push(`\n# 最近一輪分析（${lc.tTaipei}，${lc.marketOpen ? "盤中" : "盤後"}，${lc.executed ? "已模擬下單" : "僅建議"}，來源 ${lc.source}）`);
  const idx = lc.indices?.taiex, otc = lc.indices?.otc;
  if (idx) L.push(`加權指數 ${idx.price}（${sign(idx.changePct, 2)}%）${otc ? `，櫃買 ${otc.price}（${sign(otc.changePct, 2)}%）` : ""}`);
  const tf = lc.taifex?.latest;
  if (tf) L.push(`臺指期${tf.session === "night" ? "夜盤" : "日盤"}：${tf.price}，對結算價 ${sign(tf.changePct, 2)}%（${sign(tf.change, 0)} 點），期現價差 ${sign(tf.basis, 0)}，高低 ${tf.high}/${tf.low}，量 ${tf.volume}，時間 ${tf.time}`);
  const g = lc.global || {};
  const ses = { pre: "盤前", post: "盤後", regular: "盤中", closed: "收盤", futures: "期貨" };
  const gl = Object.values(g).filter((v) => v?.price != null).map((v) => `${v.label} ${v.price}（${sign(v.changePct, 2)}%${v.session ? "，" + ses[v.session] : ""}${v.ret5 != null ? "，5日 " + sign(v.ret5) + "%，20日 " + sign(v.ret20) + "%" : ""}）`).join("；");
  if (gl) L.push(`國際與美股：${gl}`);
  if (lc.macro) L.push(`總經分析師 ${sign(lc.macro.score)}（${lc.macro.data?.regime || ""}）：${(lc.macro.points || []).join("；")}`);
  L.push(`總經新聞情緒 ${sign(lc.macroSentiment, 2)}`);
  if (lc.ai) {
    L.push(`\n## 投資委員會（${lc.ai.model}）`);
    L.push(`市場觀點：${lc.ai.market_view}（風險 ${lc.ai.risk_level}）`);
    for (const d of lc.ai.discussion || []) L.push(`- ${d.analyst} ${d.stance_zh}：${d.summary}`);
    if (lc.ai.action_plan) L.push(`行動方案：${lc.ai.action_plan}`);
  }
  if (lc.summary?.conclusion && !lc.ai) L.push(`\n投資長總結：${lc.summary.conclusion}\n行動方案：${lc.summary.actionPlan || ""}`);
  L.push(`\n## 各標的`);
  for (const a of Object.values(lc.analyses || {})) {
    const d = (lc.decisions || []).find((x) => x.symbol === a.symbol);
    const I = a.indicators || {};
    L.push(`### ${a.symbol} ${a.name}  現價 ${a.price}（${sign(a.changePct, 2)}%）綜合 ${sign(a.score, 1)}  決策 ${d ? `${d.action}${d.shares ? " " + d.shares + " 股" : ""}：${d.reason}` : "--"}`);
    L.push(`指標：MA5/20/60 ${I.ma5}/${I.ma20}/${I.ma60}，RSI ${I.rsi14}，MACD柱 ${I.macdHist}，K/D ${I.k}/${I.d}，布林位置 ${I.bbPos}%，量比 ${I.volRatio}，5/20/60日 ${sign(I.ret5)}/${sign(I.ret20)}/${sign(I.ret60)}%`);
    for (const [id, b] of Object.entries(a.analysts || {})) if (id !== "macro") L.push(`${b.label} ${sign(b.score)}（信心 ${b.confidence}）：${(b.points || []).slice(0, 3).join("；")}`);
    if (a.news?.length) L.push(`新聞：${a.news.slice(0, 4).map((n) => n.title).join(" / ")}`);
  }
  if (lc.macroNews?.length) L.push(`\n## 總經／世界新聞\n` + lc.macroNews.slice(0, 10).map((n) => `- [${n.source}] ${n.title}`).join("\n"));
  return L.join("\n");
}

const SES = { pre: "盤前", post: "盤後", regular: "盤中", closed: "收盤", futures: "期貨" };
/** 問的當下抓的即時資料（期交所 3 分鐘、Yahoo 10 分鐘快取），放在快取區塊之後，不影響 prompt cache */
export async function buildLiveBlock() {
  const [tf, g] = await Promise.all([getTaifex().catch(() => null), getGlobalMarkets().catch(() => ({}))]);
  const L = [`# 即時資料（${taipeiNow()}，${isMarketOpen() ? "台股盤中" : "台股盤後"}）`];
  const c = tf?.latest;
  if (c) L.push(`臺指期${c.session === "night" ? "夜盤" : "日盤"} ${c.name}：${c.price}，對結算價 ${sign(c.changePct, 2)}%（${sign(c.change, 0)} 點），期現價差 ${sign(c.basis, 0)}，高 ${c.high} 低 ${c.low}，量 ${c.volume}，時間 ${c.time}；現貨 ${tf.spot}`);
  else L.push(`臺指期：目前抓不到報價`);
  const gl = Object.values(g).filter((v) => v?.price != null).map((v) => `${v.label} ${v.price}（${sign(v.changePct, 2)}%${v.session ? "，" + SES[v.session] : ""}）`).join("；");
  if (gl) L.push(`國際與美股：${gl}`);
  return L.join("\n");
}

/**
 * 串流回答。history：[{role, content}]（最後一則是使用者）。
 * yield 文字片段；結束時 return { usage, stop_reason, text }。
 */
export async function* chatStream({ state, history, model = "claude-opus-5-5", effort = "low" }) {
  loadEnv();
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const ws = (process.env.ANTHROPIC_WORKSPACE_ID || "").trim();
  const client = new Anthropic(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {});
  const context = buildContext(state);
  const live = await buildLiveBlock();
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const stream = client.messages.stream({
    model,
    max_tokens: 8000,
    system: [
      { type: "text", text: SYSTEM },
      { type: "text", text: "# 背景資料（最近一輪分析）\n" + context, cache_control: { type: "ephemeral" } },
      { type: "text", text: live + "\n\n即時資料比背景資料新；兩者衝突時以即時資料為準，並提醒對方背景分析是哪個時間點做的。" },
    ],
    messages,
    output_config: { effort },
  });
  let text = "";
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") { text += ev.delta.text; yield ev.delta.text; }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") throw new Error("模型拒絕回答：" + (final.stop_details?.explanation || ""));
  return { usage: final.usage, stop_reason: final.stop_reason, text, model: final.model };
}
