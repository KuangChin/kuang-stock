// 本機抓投顧 YouTube 字幕（yt-dlp），推到雲端讓 Vercel 上的分析也看得到完整內容。
// 用法：APP_URL=https://kuang-stock.vercel.app CRON_SECRET=... npm run advisors-push
// （兩個值也可以放在 .env）
import { loadEnv } from "../src/env.js";
import { getAdvisorItems, getTranscript } from "../src/advisors.js";

loadEnv();
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET || "";
if (!APP_URL || !SECRET) { console.error("需要 APP_URL 與 CRON_SECRET（環境變數或 .env）"); process.exit(1); }

const items = await getAdvisorItems({});
const yt = items.filter((x) => x.type === "youtube");
console.log(`最近一週 ${items.length} 集，其中 YouTube ${yt.length} 集`);
const transcripts = [];
for (const it of yt) {
  const text = await getTranscript(it.videoId, { fetchIfMissing: true });
  console.log(`- ${it.sourceName}「${it.title.slice(0, 40)}」字幕 ${text ? text.length + " 字" : "無"}`);
  if (text) transcripts.push({ videoId: it.videoId, text });
}
if (!transcripts.length) { console.log("沒有字幕可推送"); process.exit(0); }
const r = await fetch(`${APP_URL}/api/advisors/transcripts`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ transcripts }) });
const j = await r.json().catch(() => ({}));
if (!r.ok) { console.error("推送失敗", r.status, j); process.exit(1); }
console.log(`已推送 ${j.stored} 集字幕到 ${APP_URL}；下一輪雲端分析會用到。`);
