// 投顧觀點：抓 YouTube 頻道 / Podcast 的最新集數（RSS，不用金鑰），
// 本機有 yt-dlp 時再抓 YouTube 自動字幕，交給 Claude 整理成「每位老師對大盤與個股的看法」，
// 餵給第六位分析師（投顧）、投資委員會與投資長對話。
// 雲端（Vercel）抓不到字幕，只用標題與說明；字幕可由本機 `npm run advisors-push` 推上去。
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v4";
import { loadEnv } from "./env.js";
import { storage, isServerless } from "./storage.js";

export const DEFAULT_ADVISORS = [
  { id: "john", name: "請支援輸贏（林睿閎 John）", type: "youtube", channelId: "UCXB8cCqwOHP3BmyhYLAUs0g" },
  { id: "commuter", name: "給通勤族的飆股報告書", type: "youtube", channelId: "UCyqcTH_Hvx3wJYLDRZ5GCSw" },
  { id: "yu", name: "游庭皓的財經皓角", type: "youtube", channelId: "UC0lbAQVpenvfA2QqzsRtL_g" },
  { id: "gooaye", name: "股癌（Podcast）", type: "podcast", feedUrl: "https://feeds.soundon.fm/podcasts/954689a5-3096-43a4-a80b-7810b219cef3.xml" },
];
const DAYS = 7;            // 只看最近 7 天
const PER_SOURCE = 4;      // 每個來源最多幾集
const ITEMS_TTL = 30 * 60 * 1000;
const SUMMARY_TTL = 12 * 3600 * 1000;
const TRANSCRIPT_MAX = 9000; // 每集字幕最多餵多少字
const UA = { "User-Agent": "Mozilla/5.0" };

const decode = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
const stripHtml = (s) => decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (block, name) => (block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`)) || [, ""])[1];

export function advisorSources(config) {
  const list = Array.isArray(config?.advisors) && config.advisors.length ? config.advisors : DEFAULT_ADVISORS;
  return list.filter((a) => a.enabled !== false);
}

async function fetchText(url) {
  let err;
  for (let i = 0; i < 3; i++) { // YouTube 的 RSS 偶爾回 404/500，重試幾次
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { err = e; await new Promise((res) => setTimeout(res, 1500 * (i + 1))); }
  }
  throw err;
}

async function youtubeItems(src) {
  // 頻道 feed 很常隨機 404/500；失敗就改用上傳清單 feed（UU + 頻道 id 去掉 UC）
  let xml;
  try { xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${src.channelId}`); }
  catch { xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?playlist_id=UU${src.channelId.slice(2)}`); }
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const b = m[1];
    const vid = tag(b, "yt:videoId");
    if (!vid) continue;
    out.push({ id: `yt:${vid}`, videoId: vid, source: src.id, sourceName: src.name, type: "youtube", title: decode(tag(b, "title")), link: `https://www.youtube.com/watch?v=${vid}`, published: tag(b, "published"), description: stripHtml(tag(b, "media:description")).slice(0, 600) });
  }
  return out;
}

async function podcastItems(src) {
  const xml = await fetchText(src.feedUrl);
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const guid = decode(tag(b, "guid")) || decode(tag(b, "link"));
    const pub = tag(b, "pubDate");
    // 說明文大多是廣告，只留前段並去掉網址
    const desc = stripHtml(tag(b, "description") || tag(b, "content:encoded")).replace(/https?:\/\/\S+/g, "").slice(0, 500);
    out.push({ id: `pod:${guid.slice(-40)}`, source: src.id, sourceName: src.name, type: "podcast", title: decode(tag(b, "title")), link: decode(tag(b, "link")), published: pub ? new Date(pub).toISOString() : null, description: desc });
  }
  return out;
}

/** 最近 7 天各來源的集數（30 分鐘快取） */
export async function getAdvisorItems(config) {
  const sources = advisorSources(config);
  const key = "advisors:items:" + sources.map((s) => s.id).join(",");
  const cached = await storage.cacheGet(key, ITEMS_TTL).catch(() => null);
  if (cached) return cached;
  const since = Date.now() - DAYS * 86400e3;
  const all = [];
  await Promise.all(sources.map(async (src) => {
    const skey = `advisors:src:${src.id}`;
    let items;
    try {
      items = src.type === "podcast" ? await podcastItems(src) : await youtubeItems(src);
      if (items.length) await storage.cacheSet(skey, items).catch(() => {});
    } catch (e) {
      items = (await storage.cacheGet(skey, 3 * 86400e3).catch(() => null)) || []; // 抓不到就用三天內的舊清單
      console.warn("[advisors]", src.name, e.message, items.length ? `（用舊清單 ${items.length} 集）` : "");
    }
    all.push(...items.filter((x) => x.published && new Date(x.published).getTime() >= since).sort((a, b) => b.published.localeCompare(a.published)).slice(0, PER_SOURCE));
  }));
  all.sort((a, b) => b.published.localeCompare(a.published));
  if (all.length) await storage.cacheSet(key, all).catch(() => {});
  return all;
}

// ---------- 字幕（本機 yt-dlp） ----------
async function ytdlpPath() {
  const cands = [process.env.YTDLP, path.join(os.homedir(), ".local/bin/yt-dlp"), "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"].filter(Boolean);
  for (const p of cands) { try { await fs.access(p); return p; } catch {} }
  return null;
}
function vttToText(vtt) {
  const lines = [];
  let last = "";
  for (let l of vtt.split("\n")) {
    l = l.replace(/<[^>]+>/g, "").trim();
    if (!l || /^\d+$/.test(l) || l.includes("-->") || /^(WEBVTT|Kind:|Language:)/.test(l)) continue;
    if (l !== last) lines.push(l);
    last = l;
  }
  return lines.join(" ");
}
// YouTube 對字幕下載限流很兇（429）：同一程序內失敗的影片 1 小時內不再試，每輪最多抓 3 部、每部間隔幾秒
const failedAt = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runYtdlp(bin, dir, videoId, langs) {
  // 原始自動字幕的語言碼不固定（zh 或 zh-TW）；其他 zh-* 多半是翻譯軌，多要會被 429。
  // 就算 yt-dlp 回錯（例如其中一軌 429），只要有寫出 .vtt 就算成功。
  let err = null;
  await new Promise((res) => execFile(bin, ["--skip-download", "--write-auto-sub", "--write-sub", "--sub-lang", langs, "--sub-format", "vtt", "--sleep-subtitles", "2", "-o", path.join(dir, "v"), `https://www.youtube.com/watch?v=${videoId}`], { timeout: 120000 }, (e, so, se) => { if (e) err = new Error((se || e.message).split("\n").filter((l) => l.startsWith("ERROR")).join("; ") || e.message); res(); }));
  const f = (await fs.readdir(dir)).find((x) => x.endsWith(".vtt"));
  if (f) return vttToText(await fs.readFile(path.join(dir, f), "utf8"));
  if (err) throw err;
  return null;
}
export async function getTranscript(videoId, { fetchIfMissing = !isServerless } = {}) {
  const key = `transcript:${videoId}`;
  const cached = await storage.cacheGet(key).catch(() => null);
  if (cached != null) return cached;
  if (!fetchIfMissing) return null;
  if (Date.now() - (failedAt.get(videoId) || 0) < 3600e3) return null;
  const bin = await ytdlpPath();
  if (!bin) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ks-sub-"));
  try {
    let text = null, lastErr = null;
    const langs = "zh-TW,zh";
    try { text = await runYtdlp(bin, dir, videoId, langs); } catch (e) { lastErr = e; if (/429/.test(e.message)) { await sleep(20000); try { text = await runYtdlp(bin, dir, videoId, langs); } catch (e2) { lastErr = e2; } } }
    if (text == null) { failedAt.set(videoId, Date.now()); console.warn("[advisors] 字幕失敗", videoId, lastErr?.message || "沒有字幕"); return null; }
    await storage.cacheSet(key, text).catch(() => {});
    return text;
  } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
/** 由外部（本機腳本）寫入字幕，雲端用 */
export async function putTranscript(videoId, text) { await storage.cacheSet(`transcript:${videoId}`, String(text || "").slice(0, 40000)); }

// ---------- Claude 整理 ----------
const Stance = z.enum(["bullish", "bearish", "neutral"]);
const SummarySchema = z.object({
  market: z.object({ score: z.number().min(-2).max(2), stance: Stance, points: z.array(z.string()).max(5).describe("各位老師對大盤的看法，每點 40 字內，註明是誰說的") }),
  items: z.array(z.object({ id: z.string(), stance: Stance, summary: z.string().describe("這一集的重點 60 字內（繁體中文）"), stocks: z.array(z.object({ symbol: z.string().describe("4-6 位數代碼，不確定就留空字串"), name: z.string(), stance: Stance, note: z.string().describe("老師怎麼說，30 字內") })).max(12) })),
  symbols: z.array(z.object({ symbol: z.string(), score: z.number().min(-2).max(2), confidence: z.number().min(0).max(1), points: z.array(z.string()).max(4).describe("每點註明哪位老師、哪一集（日期）") })).describe("只列追蹤清單裡有被提到的標的"),
});

function hashOf(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); }

async function summarize(items, symbols, names, { model, effort }) {
  loadEnv();
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const ws = (process.env.ANTHROPIC_WORKSPACE_ID || "").trim();
  const client = new Anthropic(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {});
  const L = [`追蹤清單：${symbols.map((s) => `${s} ${names[s] || ""}`).join("、")}`, ""];
  for (const it of items) {
    L.push(`### [${it.id}] ${it.sourceName}｜${(it.published || "").slice(0, 10)}｜${it.title}`);
    if (it.description) L.push(`說明：${it.description}`);
    if (it.transcript) L.push(`字幕（自動產生，可能有錯字）：${it.transcript.slice(0, TRANSCRIPT_MAX)}`);
    else L.push(`（沒有字幕，只能看標題與說明）`);
    L.push("");
  }
  L.push(`請整理：1) market：綜合各位老師對台股大盤的看法給 -2～+2 分；2) items：每一集的立場、60 字重點、提到的個股與老師的看法（代碼不確定就留空）；3) symbols：追蹤清單裡「有被提到」的標的，各給 -2～+2 分、信心與理由，沒被提到的不要列。只根據內容，不要自己補充行情。`);
  const res = await client.messages.parse({
    model, max_tokens: 6000, output_config: { effort, format: zodOutputFormat(SummarySchema) },
    system: "你是投資研究助理，負責把投顧老師在影片／Podcast 裡講的內容忠實整理成結構化資料。繁體中文、台灣用語。老師沒講的不要編。",
    messages: [{ role: "user", content: L.join("\n") }],
  });
  if (res.stop_reason === "refusal") throw new Error("模型拒絕整理投顧內容");
  return { ...res.parsed_output, model: res.model, usage: res.usage };
}

/**
 * 給分析流程用：回 { t, items, market, bySymbol, model, transcripts }
 * symbols/names：目前追蹤的標的；config：state.config（可含 advisors 自訂來源與 model）
 */
export async function getAdvisorViews(symbols, names, config = {}) {
  const items = await getAdvisorItems(config);
  if (!items.length) return null;
  let fetched = 0;
  for (const it of items) {
    if (it.type !== "youtube") continue;
    const cached = await storage.cacheGet(`transcript:${it.videoId}`).catch(() => null);
    if (cached != null) { it.transcript = cached || null; continue; }
    if (fetched >= 3) continue; // 其餘留到下一輪，避免被 YouTube 限流
    if (fetched) await sleep(4000);
    it.transcript = (await getTranscript(it.videoId)) || null; fetched++;
  }
  const transcripts = items.filter((x) => x.transcript).length;
  const model = config.advisorsModel || config.ai?.model || "claude-sonnet-5-5";
  const sig = hashOf(items.map((x) => x.id + (x.transcript ? "T" : "")).join("|") + "|" + symbols.join(",") + "|" + model);
  const key = `advisors:summary:${sig}`;
  let sum = await storage.cacheGet(key, SUMMARY_TTL).catch(() => null);
  if (!sum) {
    sum = await summarize(items, symbols, names, { model, effort: "low" });
    await storage.cacheSet(key, sum).catch(() => {});
  }
  const byId = Object.fromEntries((sum.items || []).map((x) => [x.id, x]));
  const out = {
    t: new Date().toISOString(),
    model: sum.model,
    transcripts,
    market: sum.market,
    items: items.map(({ transcript, ...it }) => ({ ...it, hasTranscript: Boolean(transcript), stance: byId[it.id]?.stance || null, summary: byId[it.id]?.summary || null, stocks: byId[it.id]?.stocks || [] })),
    bySymbol: Object.fromEntries((sum.symbols || []).filter((x) => symbols.includes(x.symbol)).map((x) => [x.symbol, { score: x.score, confidence: x.confidence, points: x.points }])),
  };
  await storage.cacheSet("advisors:latest", out).catch(() => {});
  return out;
}
