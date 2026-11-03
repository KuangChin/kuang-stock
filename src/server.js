// 本機伺服器：靜態檔 + API + setInterval 排程。設定 APP_PASSWORD 時同樣要求登入。
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState } from "./store.js";
import { startScheduler } from "./engine.js";
import { taipeiNow } from "./twse.js";
import { handleApi } from "./routes.js";
import { backend } from "./storage.js";
import { authEnabled, verifySession, parseCookies, COOKIE, PUBLIC_PATHS } from "./auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");
const PORT = Number(process.env.PORT || 8787);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const readBody = (req) => new Promise((resolve, reject) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on("error", reject); });

async function serveStatic(req, res, pathname) {
  let p = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
}

await loadState();
startScheduler();
http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname.startsWith("/api/")) {
    let body = null;
    if (req.method === "POST") {
      try { body = await readBody(req); } catch { res.writeHead(400); return res.end("bad json"); }
    }
    const r = await handleApi({ method: req.method, url: u, headers: req.headers, body, secure: false });
    if (r.stream) {
      res.writeHead(r.status, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
      for await (const ev of r.stream) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      return res.end();
    }
    res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", ...r.headers });
    return res.end(JSON.stringify(r.body));
  }
  if (req.method !== "GET") { res.writeHead(404); return res.end(); }
  // 頁面保護：未登入導向登入頁（與 Vercel 的 middleware.js 行為一致）
  if (authEnabled() && !PUBLIC_PATHS.has(u.pathname) && !(await verifySession(parseCookies(req.headers.cookie || "")[COOKIE]))) {
    res.writeHead(302, { Location: "/login.html" });
    return res.end();
  }
  return serveStatic(req, res, u.pathname);
}).listen(PORT, () => console.log(`kuang-stock 模擬操盤已啟動：http://localhost:${PORT}  (${taipeiNow()})  儲存：${backend}${authEnabled() ? "  登入：開" : ""}`));
