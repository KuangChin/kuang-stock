// Vercel catch-all function：所有 /api/* 都由同一份路由表處理（src/routes.js）
import { handleApi } from "../src/routes.js";

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const r = await handleApi({ method: req.method, url, headers: req.headers, body: body || {}, secure: true });
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  res.status(r.status).json(r.body);
}
