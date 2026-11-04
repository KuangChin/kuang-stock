// 投資長對話：以最近一輪分析（state.lastCycle）與帳戶狀態為背景，用 Claude 串流回答。
// 背景放在 system 並設 cache_control，同一輪分析內多次對話只付一次完整輸入費。
import { loadEnv } from "./env.js";
import { valuation } from "./portfolio.js";
import { taipeiNow, isMarketOpen, searchStocks } from "./twse.js";
import { addLog } from "./store.js";
import { runBacktest, normalizeRange } from "./backtest.js";
import { isServerless } from "./storage.js";
import { DEFAULT_WEIGHTS, LABELS } from "./analysts/index.js";
import { getTaifex } from "./taifex.js";
import { getGlobalMarkets } from "./yahoo.js";
import { getSeries, summarizeSeries, SERIES } from "./history.js";

export const CHAT_MAX = 40; // 保留的對話則數
const sign = (v, d = 1) => (v == null ? "--" : (v > 0 ? "+" : "") + Number(v).toFixed(d));

const SYSTEM = `你是「投資長」，主持一個台股模擬交易帳戶的投資委員會，底下有技術線型、基本面、籌碼、總經、情緒五位分析師。
你正在和帳戶主人對話。原則：
1. 回答依據背景資料裡的分析、持股、新聞與風控參數；資料沒有的事要明說「資料裡沒有」，不要編造數字。
2. 用繁體中文、台灣用語，口吻像一位務實的投資長：直接、具體、講理由，不說教，不免責聲明連篇。
3. 這是模擬帳戶，你不能直接下單；若建議操作，說清楚標的、方向、股數或比例、觸發條件，請對方在頁面按「分析並模擬下單」或手動下單。
   你可以用工具修改設定：追蹤清單（add_watchlist / remove_watchlist / set_watchlist）、風控參數（set_risk，例如停損、單一持股上限、買賣門檻）、
   六位分析師的權重（set_weights）、跑回測（run_backtest）、查目前設定（get_settings）。對方給的是名稱時先用 search_stock 查到正確代碼。
   對方問過去一段時間的走勢（加權指數、台指期、費半、S&P 500、VIX、匯率、個股）時，用 get_history 拿日線摘要再回答，不要說拿不到。
   對方要「鎖定某個族群」時，自己挑出該族群在台股的代表性標的（用 search_stock 確認代碼），用 set_watchlist 整份換掉，並說明挑了哪些、為什麼。
   改完用幾句話回報改了什麼、現在的值是多少。回測結果要講報酬、最大回撤、交易次數、與 0050 同期比較，並給一句評語。追蹤清單的股票會在下一輪分析納入。
4. 回答長度看問題：閒聊或簡單問題兩三句就好；分析類問題用短段落或條列，不要超過 300 字，除非對方要求詳細。
5. 可以表達不同意委員會先前的結論，但要說明新理由。
6. 停損、停利等風控數字一律以背景資料「風控」那一行為準（那是帳戶主人自己設的），不要引用其他比例；「保留現金」是現金比例，不是停損。
7. 全程用繁體中文，包括呼叫工具前的過場句；不要出現英文句子。要連續跑好幾個工具時，先用一句中文說接下來要做什麼，最後一定要用中文把結果整理成結論。`;

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
  const W = state.config.weights || {};
  L.push(`分析師權重：${Object.keys(DEFAULT_WEIGHTS).map((k) => `${LABELS[k]} ${Math.round((W[k] ?? 0) * 100)}%`).join("、")}${rk.lockStopLoss ? "；停損已鎖定（自動調參不會改）" : ""}`);
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
  const adv = lc.advisors;
  if (adv?.items?.length) {
    L.push(`\n## 投顧觀點（最近一週；${adv.transcripts} 集有字幕）`);
    L.push(`大盤 ${sign(adv.market?.score)}：${(adv.market?.points || []).join("；")}`);
    for (const it of adv.items) L.push(`- ${it.sourceName} ${(it.published || "").slice(0, 10)}「${it.title}」${it.summary ? "：" + it.summary : "（只有標題）"}${it.stocks?.length ? "；提到 " + it.stocks.map((s) => `${s.symbol ? s.symbol + " " : ""}${s.name} ${{ bullish: "看多", bearish: "看空", neutral: "中性" }[s.stance]}：${s.note}`).join("、") : ""}`);
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

// ---------- 投資長可用的工具 ----------
const TOOLS = [
  { name: "search_stock", description: "用代碼或名稱搜尋台股上市／上櫃股票，回傳代碼、名稱、市場。要把股票加入追蹤前，先用它確認代碼。", input_schema: { type: "object", properties: { query: { type: "string", description: "股票代碼開頭或名稱關鍵字，例如 2330 或 台積" } }, required: ["query"] } },
  { name: "add_watchlist", description: "把股票加入追蹤清單，之後每輪分析都會納入。symbols 給 4～6 位數代碼。", input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } }, required: ["symbols"] } },
  { name: "remove_watchlist", description: "把股票從追蹤清單移除（不影響持股）。", input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } }, required: ["symbols"] } },
  { name: "set_watchlist", description: "整份替換追蹤清單（例如鎖定某個族群）。symbols 給 4～6 位數代碼；持股不受影響，仍會被分析。", input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } }, required: ["symbols"] } },
  { name: "get_settings", description: "讀目前的風控參數、分析師權重、追蹤清單、自動執行與 AI 設定。", input_schema: { type: "object", properties: {} } },
  { name: "set_risk", description: "修改風控參數，只需給要改的欄位。百分比欄位用 0～100 的數字（停損 30 代表 30%；單一持股不設限給 maxPositionPct 100）。lockStopLoss=true 表示停損固定，自動調參不得更動。", input_schema: { type: "object", properties: { stopLossPct: { type: "number" }, takeProfitPct: { type: "number" }, maxPositionPct: { type: "number" }, perTradePct: { type: "number" }, minCashPct: { type: "number" }, buyThreshold: { type: "number", description: "綜合分數 -8～+8，達此值買進" }, sellThreshold: { type: "number" }, maxPositions: { type: "integer" }, cooldownDays: { type: "integer" }, lockStopLoss: { type: "boolean" } } } },
  { name: "set_weights", description: "調整六位分析師的權重（technical 技術、fundamental 基本面、chips 籌碼、macro 總經、sentiment 情緒、advisor 投顧），用 0～100 的數字，只需給要改的；系統會自動把總和正規化成 100%。", input_schema: { type: "object", properties: { technical: { type: "number" }, fundamental: { type: "number" }, chips: { type: "number" }, macro: { type: "number" }, sentiment: { type: "number" }, advisor: { type: "number" } } } },
  { name: "get_history", description: "拿日線歷史摘要（報酬、高低點與日期、最大回撤、均線、約 50 個取樣點）。series 可多個：taiex 加權指數、tx 台指期近月連續、sox 費城半導體、sp500、nasdaq、vix、usdtwd 美元台幣、us10y 美債十年、dxy 美元指數、tsm 台積電ADR、nvda，或 4～6 位數台股代碼。時間段用 days（預設 240 個交易日）或 from/to（YYYY-MM-DD）。", input_schema: { type: "object", properties: { series: { type: "array", items: { type: "string" } }, days: { type: "integer" }, from: { type: "string" }, to: { type: "string" } }, required: ["series"] } },
  { name: "run_backtest", description: "用目前風控參數回測（只用技術線型分析師，沒有籌碼與新聞的歷史）。時間段兩種給法：days（最近 N 個交易日，預設 240）或 from/to（YYYY-MM-DD，指定起迄日期，例如「跑 2025 上半年」就是 from 2025-01-01、to 2025-06-30；只給 from 就跑到今天）。symbols 不給就用追蹤清單＋持股。要花 30～120 秒。", input_schema: { type: "object", properties: { days: { type: "integer" }, from: { type: "string", description: "起日 YYYY-MM-DD" }, to: { type: "string", description: "迄日 YYYY-MM-DD" }, symbols: { type: "array", items: { type: "string" } } } } },
];
const PCT_FIELDS = ["stopLossPct", "takeProfitPct", "maxPositionPct", "perTradePct", "minCashPct"];
const CLOUD_BT = { symbols: 10, days: 250 };
async function runTool(name, input, state, changed) {
  const wl = state.config.watchlist;
  if (name === "search_stock") return { results: await searchStocks(String(input.query || ""), 10) };
  const syms = [...new Set((input.symbols || []).map((x) => String(x).trim()).filter((x) => /^\d{4,6}$/.test(x)))];
  if (!syms.length) return { error: "沒有有效的股票代碼" };
  if (name === "add_watchlist") {
    const added = [], unknown = [], exists = [];
    for (const s of syms) {
      if (wl.includes(s)) { exists.push(s); continue; }
      const hit = (await searchStocks(s, 5)).find((r) => r.code === s);
      if (!hit) { unknown.push(s); continue; }
      wl.push(s); added.push(`${s} ${hit.name}`);
    }
    if (added.length) { changed.add("config"); changed.add("log"); addLog(`投資長新增追蹤：${added.join("、")}`); }
    return { added, alreadyExists: exists, notFound: unknown, watchlist: [...wl] };
  }
  if (name === "remove_watchlist") {
    const removed = syms.filter((s) => wl.includes(s));
    state.config.watchlist = wl.filter((s) => !removed.includes(s));
    if (removed.length) { changed.add("config"); changed.add("log"); addLog(`投資長移除追蹤：${removed.join("、")}`); }
    return { removed, watchlist: [...state.config.watchlist] };
  }
  if (name === "set_watchlist") {
    const ok = [], unknown = [];
    for (const s of syms) { const hit = (await searchStocks(s, 5)).find((r) => r.code === s); if (hit) ok.push(`${s} ${hit.name}`); else unknown.push(s); }
    if (!ok.length) return { error: "沒有有效代碼", notFound: unknown };
    state.config.watchlist = ok.map((x) => x.split(" ")[0]);
    changed.add("config"); changed.add("log"); addLog(`投資長重設追蹤清單：${ok.join("、")}`);
    return { watchlist: ok, notFound: unknown };
  }
  return { error: "未知的工具 " + name };
}
async function runSettingTool(name, input, state, changed) {
  const c = state.config;
  if (name === "get_settings") return { risk: c.risk, weights: c.weights, watchlist: c.watchlist, auto: c.auto, ai: { enabled: c.ai.enabled, model: c.ai.model } };
  if (name === "set_risk") {
    const before = { ...c.risk }, applied = {};
    for (const [k, v] of Object.entries(input || {})) {
      if (v == null) continue;
      if (PCT_FIELDS.includes(k)) { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100) return { error: `${k} 要在 0～100` }; c.risk[k] = +(n / 100).toFixed(4); applied[k] = `${n}%`; }
      else if (["buyThreshold", "sellThreshold", "maxPositions", "cooldownDays"].includes(k)) { c.risk[k] = Number(v); applied[k] = Number(v); }
      else if (k === "lockStopLoss") { c.risk.lockStopLoss = Boolean(v); applied[k] = Boolean(v); }
    }
    if (!Object.keys(applied).length) return { error: "沒有可套用的欄位" };
    changed.add("config"); changed.add("log");
    addLog(`投資長修改風控：${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join("、")}`);
    return { applied, before, risk: c.risk };
  }
  if (name === "set_weights") {
    const w = { ...c.weights };
    for (const k of Object.keys(DEFAULT_WEIGHTS)) if (input?.[k] != null) w[k] = Math.max(0, Number(input[k]));
    const sum = Object.keys(DEFAULT_WEIGHTS).reduce((t, k) => t + (w[k] ?? 0), 0) || 1;
    for (const k of Object.keys(DEFAULT_WEIGHTS)) w[k] = +((w[k] ?? 0) / sum).toFixed(4);
    c.weights = w; changed.add("config"); changed.add("log");
    const txt = Object.keys(DEFAULT_WEIGHTS).map((k) => `${LABELS[k]} ${Math.round(w[k] * 100)}%`).join("、");
    addLog(`投資長調整權重：${txt}`);
    return { weights: txt };
  }
  if (name === "get_history") {
    const list = [...new Set((input?.series || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 6);
    if (!list.length) return { error: "series 要給至少一個", available: Object.keys(SERIES) };
    const days = Math.min(1200, Math.max(20, Number(input?.days) || 240));
    const { from, to } = normalizeRange(input || {});
    const out = [];
    for (const k of list) {
      try { out.push(summarizeSeries(await getSeries(k, { days, from, to }))); } catch (e) { out.push({ series: k, error: e.message }); }
    }
    return { results: out, note: "台指期是每天成交量最大的一般時段合約接起來的近月連續，換月當天會有價差" };
  }
  if (name === "run_backtest") {
    let symbols = (input?.symbols || []).map(String).filter((x) => /^\d{4,6}$/.test(x));
    if (!symbols.length) symbols = [...new Set([...Object.keys(state.positions), ...c.watchlist])];
    let days = Math.max(30, Number(input?.days) || 240);
    const { from, to } = normalizeRange(input || {});
    if (isServerless) { symbols = symbols.slice(0, CLOUD_BT.symbols); days = Math.min(days, CLOUD_BT.days); }
    const months = Math.ceil((days + 65) / 21) + 1; // 回測需要 65 天暖機
    const r = await runBacktest({ symbols, cash: state.initialEquity || c.initialCash, days, from, to, maxDays: isServerless ? CLOUD_BT.days : null, risk: c.risk, fees: c.fees, months });
    if (r.error) return { error: r.error, from, to };
    const span = from ? `${r.start}～${r.end}` : `${days} 天`;
    addLog(`投資長回測 ${symbols.length} 檔 ${span}：報酬 ${r.returnPct}%，回撤 ${r.maxDrawdownPct}%，0050 ${r.benchmarkReturnPct}%`); changed.add("log");
    return { symbols: r.symbols, days: r.days, start: r.start, end: r.end, returnPct: r.returnPct, benchmarkReturnPct: r.benchmarkReturnPct, maxDrawdownPct: r.maxDrawdownPct, trades: r.trades, sells: r.sells, winRate: r.winRate, realized: r.realized, finalEquity: r.finalEquity, note: (r.truncated ? `雲端最多 ${CLOUD_BT.days} 個交易日，實際從 ${r.start} 起算。` : "") + "只用技術線型分析師回測；籌碼、新聞、投顧沒有歷史快照" };
  }
  return null;
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
  const system = [
    { type: "text", text: SYSTEM },
    { type: "text", text: "# 背景資料（最近一輪分析）\n" + context, cache_control: { type: "ephemeral" } },
    { type: "text", text: live + "\n\n即時資料比背景資料新；兩者衝突時以即時資料為準，並提醒對方背景分析是哪個時間點做的。" },
  ];
  let text = "", final = null;
  const changed = new Set();
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  // 最多 MAX_ROUNDS 回合工具；用完時再叫一次「不准用工具」，逼他把結果整理成中文結論，不然對話會停在過場句
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const exhausted = round === MAX_ROUNDS;
    const stream = client.messages.stream({ model, max_tokens: 8000, system, tools: TOOLS, messages, output_config: { effort }, ...(exhausted ? { tool_choice: { type: "none" } } : {}) });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") { text += ev.delta.text; yield ev.delta.text; }
    }
    final = await stream.finalMessage();
    for (const k of Object.keys(usage)) usage[k] += final.usage?.[k] || 0;
    if (final.stop_reason === "refusal") throw new Error("模型拒絕回答：" + (final.stop_details?.explanation || ""));
    if (final.stop_reason !== "tool_use") break;
    const uses = final.content.filter((b) => b.type === "tool_use");
    messages.push({ role: "assistant", content: final.content });
    const results = [];
    for (const u of uses) {
      yield { progress: progressLabel(u.name, u.input) };
      let out;
      try { out = (await runSettingTool(u.name, u.input, state, changed)) ?? (await runTool(u.name, u.input, state, changed)); } catch (e) { out = { error: e.message }; }
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
    if (text && !text.endsWith("\n")) { text += "\n\n"; yield "\n\n"; }
  }
  return { usage, stop_reason: final.stop_reason, text, model: final.model, changed: [...changed] };
}

const MAX_ROUNDS = 10;
/** 工具執行中顯示在對話框的中文進度 */
function progressLabel(name, input = {}) {
  const span = input.from ? `${input.from}～${input.to || "今天"}` : `${input.days || 240} 天`;
  if (name === "run_backtest") return `回測 ${input.symbols?.length ? input.symbols.length + " 檔" : "追蹤清單"} ${span}…`;
  if (name === "get_history") return `查 ${(input.series || []).join("、")} 走勢 ${span}…`;
  if (name === "set_risk") return "修改風控參數…";
  if (name === "set_weights") return "調整分析師權重…";
  if (name === "search_stock") return `查 ${input.query || ""}…`;
  if (name === "get_settings") return "讀取目前設定…";
  return "更新追蹤清單…";
}
