// Vercel Edge Middleware：靜態頁面也要登入才能看（public/ 由 Vercel 直接提供，function 管不到）。
// API 的驗證在 src/routes.js；這裡只擋頁面與 /api 以外的靜態資源。
import { verifySession, parseCookies, COOKIE, PUBLIC_PATHS, authEnabled } from "./src/auth.js";

export const config = { matcher: ["/((?!api/).*)"] };

export default async function middleware(request) {
  if (!authEnabled(process.env)) return;
  const url = new URL(request.url);
  if (PUBLIC_PATHS.has(url.pathname)) return;
  const token = parseCookies(request.headers.get("cookie") || "")[COOKIE];
  if (await verifySession(token, process.env)) return;
  return Response.redirect(new URL("/login.html", request.url), 302);
}
