import { loadState } from "./store.js";
import { runCycle } from "./engine.js";
import { runBacktest } from "./backtest.js";
const [cmd, ...args] = process.argv.slice(2);
await loadState();
if (cmd === "cycle") {
  const r = await runCycle({ execute: args.includes("--execute"), source: "cli" });
  console.log(JSON.stringify({ time: r.tTaipei, marketOpen: r.marketOpen, valuation: r.valuation, decisions: r.decisions.map((d) => `${d.symbol} ${d.action} ${d.shares} | ${d.reason}`), aiError: r.aiError }, null, 1));
} else if (cmd === "backtest") {
  const symbols = (args[0] || "2330,2317,2454,0050").split(",");
  // 第三個參數可以是天數，或 起日:迄日（例如 2025-01-01:2025-06-30，迄日可省略）
  const span = args[2] || "120";
  const [from, to] = span.includes("-") ? span.split(":") : [null, null];
  const r = await runBacktest({ symbols, cash: Number(args[1] || 1000000), days: Number(span) || 120, from, to });
  const { curve, tradeLog, ...summary } = r;
  console.log(JSON.stringify(summary, null, 1));
  console.log(tradeLog.slice(0, 15).map((t) => `${t.t} ${t.side} ${t.symbol} ${t.shares}@${t.price} realized=${t.realized} ${t.reason}`).join("\n"));
} else console.log("usage: node src/cli.js cycle [--execute] | backtest <symbols> <cash> <days|from:to>");
