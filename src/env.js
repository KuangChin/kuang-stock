// 讀取專案根目錄 .env（本機用；Vercel 上由環境變數提供，檔案不存在就略過）
import { readFileSync } from "node:fs";
import path from "node:path";

export function loadEnv() {
  try {
    const txt = readFileSync(path.resolve(".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch {}
}
