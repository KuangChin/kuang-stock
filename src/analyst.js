// AI 分析師（可選）：以 Claude 綜合技術指標、新聞、規則訊號，產生結構化決策。
// 沒有 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 時自動停用，系統只跑規則引擎。
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { loadEnv } from "./env.js";
import { isServerless } from "./storage.js";
export { loadEnv };

const Discussion = z.array(
  z.object({
    analyst: z.enum(["technical", "fundamental", "chips", "macro", "sentiment"]),
    stance_zh: z.enum(["偏多", "偏空", "中性"]),
    summary: z.string().describe("該分析師在委員會討論中的一句話結論（繁體中文，30 字內）"),
  })
);
const DecisionSchema = z.object({
  market_view: z.string().describe("一段 2-4 句的大盤與總經看法（繁體中文）"),
  risk_level: z.enum(["low", "medium", "high"]),
  discussion: Discussion.describe("五位分析師各一筆"),
  action_plan: z.string().describe("給投資人的行動方案，1-3 句，明確說要買賣什麼或為何不動（繁體中文）"),
  decisions: z.array(
    z.object({
      symbol: z.string(),
      action: z.enum(["BUY", "SELL", "HOLD"]),
      size_pct: z.number().min(0).max(100).describe("BUY 時動用現金比例；SELL 時賣出持股比例；HOLD 填 0"),
      confidence: z.number().min(0).max(1),
      reason: z.string().describe("一句話理由（繁體中文）"),
    })
  ),
});


export function aiAvailable() {
  loadEnv();
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function buildPrompt(snapshot) {
  const lines = [];
  lines.push(`時間：${snapshot.time}（台北）。市場狀態：${snapshot.marketOpen ? "盤中" : "盤後"}。`);
  const idx = snapshot.indices?.taiex;
  if (idx) lines.push(`加權指數 ${idx.price} (${idx.changePct}%)。總經新聞情緒 ${snapshot.macroSentiment}。`);
  const tf = snapshot.taifex?.latest;
  if (tf) lines.push(`臺指期${tf.session === "night" ? "夜盤" : "日盤"} ${tf.price}（對結算 ${tf.changePct > 0 ? "+" : ""}${tf.changePct}%，期現價差 ${tf.basis}，${tf.time}）。`);
  const g = snapshot.global || {};
  const gl = Object.values(g).filter((x) => x?.price != null).map((x) => `${x.label} ${x.price}（${x.changePct > 0 ? "+" : ""}${x.changePct}%${x.session && x.session !== "futures" ? "，" + { pre: "盤前", post: "盤後", regular: "盤中", closed: "收盤" }[x.session] : ""}${x.ret5 != null ? "，5日 " + (x.ret5 > 0 ? "+" : "") + x.ret5 + "%" : ""}）`).join("；");
  if (gl) lines.push(`國際市場：${gl}。`);
  lines.push(`\n帳戶：現金 ${snapshot.valuation.cash}，持股市值 ${snapshot.valuation.marketValue}，總資產 ${snapshot.valuation.total}，累積報酬 ${snapshot.valuation.returnPct}%。`);
  lines.push(`風控參數：${JSON.stringify(snapshot.risk)}`);
  lines.push(`\n持股：`);
  for (const r of snapshot.valuation.rows) lines.push(`- ${r.symbol} ${r.name}: ${r.shares} 股，成本 ${r.avgCost}，現價 ${r.price}，損益 ${r.pnlPct}%`);
  if (snapshot.macro) lines.push(`\n總經分析師：分數 ${snapshot.macro.score}（${snapshot.macro.data?.regime}）\n` + (snapshot.macro.points || []).map((x) => "  - " + x).join("\n"));
  lines.push(`\n各標的分析（五位分析師分數 -2～+2，投資長加權後 -8～+8；含初步規則決策）：`);
  for (const a of snapshot.analyses) {
    const L = a.indicators || {};
    lines.push(`\n## ${a.symbol} ${a.name}  現價 ${a.price} (${a.changePct}%)  綜合分數 ${a.score}  規則決策 ${a.ruleDecision?.action} ${a.ruleDecision?.shares || ""}`);
    lines.push(`指標：MA5 ${L.ma5} / MA20 ${L.ma20} / MA60 ${L.ma60}；RSI ${L.rsi14}；MACD柱 ${L.macdHist}；K/D ${L.k}/${L.d}；布林位置 ${L.bbPos}%；量比 ${L.volRatio}；5/20/60日報酬 ${L.ret5}/${L.ret20}/${L.ret60}%`);
    for (const [id, b] of Object.entries(a.analysts || {})) if (id !== "macro") lines.push(`${b.label}分析師 ${b.score}（信心 ${b.confidence}）：${(b.points || []).slice(0, 4).join("；")}`);
    if (a.news?.length) lines.push(`近期新聞：\n` + a.news.slice(0, 6).map((n) => `  - [${n.source}] ${n.title}`).join("\n"));
  }
  lines.push(`\n總經/世界新聞：\n` + (snapshot.macroNews || []).slice(0, 12).map((n) => `- [${n.source}] ${n.title}`).join("\n"));
  lines.push(`\n請以投資長角度主持委員會：先在 discussion 給五位分析師各一句話結論，再綜合給每個標的 BUY/SELL/HOLD 決策，最後在 action_plan 用 1-3 句明確告訴投資人該做什麼。這是模擬帳戶，請遵守風控參數，避免過度交易；沒有明確理由就 HOLD。`);
  return lines.join("\n");
}

const SYSTEM = `你是台股投資顧問，為一個模擬交易帳戶做決策。原則：
1. 以中期波段為主，不追高殺低；技術面、新聞面、大盤環境三者一致時才出手。
2. 嚴格遵守風控：單一持股不超過上限、保留現金、虧損達停損線即賣出。
3. 決策要能被規則驗證：reason 須引用具體指標或新聞。
4. 輸出繁體中文。`;

export async function aiDecide(snapshot, { model = "claude-opus-5-5", effort = "medium" } = {}) {
  loadEnv();
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const ws = (process.env.ANTHROPIC_WORKSPACE_ID || "").trim();
  const client = new Anthropic(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {});
  const res = await client.messages.parse({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content: buildPrompt(snapshot) }],
    output_config: { effort, format: zodOutputFormat(DecisionSchema) },
  });
  if (res.stop_reason === "refusal") throw new Error("模型拒絕回答：" + (res.stop_details?.explanation || ""));
  if (!res.parsed_output) throw new Error("AI 回覆無法解析");
  return { ...res.parsed_output, usage: res.usage, model };
}

/**
 * 外部分析師通道：把快照寫到 data/snapshot.json；若 data/ai_decisions.json 比快照新，
 * 就採用其內容。讓 Claude Code（有 MCP + 網路搜尋）可以離線扮演分析師。
 */
const SNAP = path.resolve("data/snapshot.json");
const DEC = path.resolve("data/ai_decisions.json");
export async function writeSnapshot(snapshot) {
  if (isServerless) return; // 雲端沒有持久磁碟，外部分析師通道只在本機使用
  await fs.mkdir(path.dirname(SNAP), { recursive: true });
  await fs.writeFile(SNAP, JSON.stringify({ ...snapshot, prompt: buildPrompt(snapshot) }, null, 1));
}
export async function readExternalDecisions(maxAgeMs = 30 * 60 * 1000) {
  if (isServerless) return null;
  try {
    const st = await fs.stat(DEC);
    if (Date.now() - st.mtimeMs > maxAgeMs) return null;
    const j = JSON.parse(await fs.readFile(DEC, "utf8"));
    return DecisionSchema.partial({ discussion: true, action_plan: true }).parse(j);
  } catch {
    return null;
  }
}
