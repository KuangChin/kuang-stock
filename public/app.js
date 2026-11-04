const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "--" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
const sign = (v, d = 0, suffix = "") => (v == null ? "--" : (v > 0 ? "+" : "") + fmt(v, d) + suffix);
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const timeStr = (iso) => (iso ? new Date(iso).toLocaleString("zh-TW", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "--");
const CSS = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let S = null; // server state
let LIVE = null; // /api/live 即時報價（台指期＋國際市場），每分鐘更新
let busy = false;

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (r.status === 401) { location.href = "/login.html"; throw new Error("請先登入"); }
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`伺服器回應不是 JSON（HTTP ${r.status}）：${text.replace(/<[^>]+>/g, " ").trim().slice(0, 160)}`); }
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg, ms = 3000) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add("hidden"), ms); }
function setBusy(b) { busy = b; $$("#btnAnalyze,#btnRun").forEach((x) => (x.disabled = b)); }

// ---------- 渲染 ----------
function tile(label, value, delta = "", c = "") { return `<div class="tile"><div class="label">${label}</div><div class="value ${c}">${value}</div><div class="delta ${c}">${delta}</div></div>`; }

function render() {
  const sw = $("#storageWarn");
  if (S.runtime?.backend === "memory") { sw.textContent = "尚未連接 Redis：資料不會保存"; sw.classList.remove("hidden"); } else sw.classList.add("hidden");
  const lc = S.lastCycle, v = lc?.valuation;
  $("#clock").textContent = S.now;
  const mb = $("#marketBadge"); mb.textContent = S.marketOpen ? "盤中" : "盤後"; mb.className = "badge " + (S.marketOpen ? "open" : "");
  const ab = $("#aiBadge"); ab.textContent = S.config.ai.enabled ? (S.aiAvailable ? "AI 分析師：啟用" : "AI 已啟用但無金鑰") : "規則引擎"; ab.className = "badge " + (S.config.ai.enabled && S.aiAvailable ? "on" : "");
  $("#btnRun").textContent = S.config.auto.enabled ? "分析並模擬下單（自動中）" : "分析並模擬下單";

  // 投資委員會結論
  const sm = lc?.summary;
  $("#committee").classList.toggle("hidden", !sm);
  if (sm) {
    $("#cmNote").textContent = `${lc.tTaipei} · ${sm.source} · ${lc.executed ? "已模擬下單" : "僅建議"}`;
    $("#cmAnalysts").innerHTML = sm.analysts.map((a) => `<div class="cm-row"><span class="who">${a.label}</span><span class="st ${a.stance === "偏多" ? "up" : a.stance === "偏空" ? "down" : "muted"}">${a.stance} ${sign(a.score, 1)}</span><span class="tx">${esc(a.text)}</span></div>`).join("");
    $("#cmConclusion").textContent = sm.conclusion;
    $("#cmPlan").textContent = sm.actionPlan;
    $("#cmActions").innerHTML = sm.actions.map((x) => `<li>${pill(x.action)} ${x.symbol} ${esc(x.name)} ${x.sharesText}${x.price ? ` @ ${fmt(x.price, 2)}` : ""}${x.amount ? `（約 ${fmt(x.amount)} 元）` : ""}${x.result ? ` <span class="muted small">${esc(x.result)}</span>` : ""}<div class="muted small">${esc(x.reason)}</div></li>`).join("");
  }

  // KPI
  const idx = lc?.indices?.taiex;
  $("#kpis").innerHTML = v
    ? tile("總資產", fmt(v.total), `累積報酬 ${sign(v.returnPct, 2, "%")}`, cls(v.returnPct)) + tile("現金", fmt(v.cash), `占 ${fmt((v.cash / v.total) * 100, 1)}%`) + tile("持股市值", fmt(v.marketValue), `${Object.keys(S.positions).length} 檔`) + tile("未實現損益", sign(v.unrealized), "", cls(v.unrealized)) + tile("今日損益", sign(v.dayPnl), "", cls(v.dayPnl)) + tile("已實現損益", sign(v.realized), `${S.trades.length} 筆交易`, cls(v.realized)) + (idx ? tile("加權指數", fmt(idx.price), `${sign(idx.change)} (${sign(idx.changePct, 2, "%")})`, cls(idx.change)) : "")
    : tile("總資產", fmt(S.cash), "尚未執行分析") + tile("現金", fmt(S.cash)) + tile("持股", Object.keys(S.positions).length + " 檔");

  // 資產曲線
  const eq = S.equity;
  $("#equityNote").textContent = eq.length ? `${eq.length} 個記錄點，起始 ${fmt(S.initialEquity)}` : "執行分析後開始記錄";
  if (eq.length) Chart.line($("#equityChart"), { x: eq.map((p) => timeStr(p.t)), series: [{ name: "總資產", values: eq.map((p) => p.total), color: CSS("--s1") }, { name: "現金", values: eq.map((p) => p.cash), color: CSS("--muted"), width: 1.5, dashed: true }], baseline: S.initialEquity });
  else $("#equityChart").innerHTML = '<div class="muted small" style="padding:20px">尚無資料</div>';

  // 持股
  const dec = Object.fromEntries((lc?.decisions || []).map((d) => [d.symbol, d]));
  const rows = v?.rows || Object.entries(S.positions).map(([symbol, p]) => ({ symbol, name: p.name, shares: p.shares, avgCost: p.avgCost, price: p.lastPrice, marketValue: null, pnl: null, pnlPct: null }));
  $("#posTable tbody").innerHTML = rows.length ? rows.map((r) => `<tr class="clickable" data-sym="${r.symbol}"><td>${r.symbol}</td><td>${esc(r.name)}</td><td class="num">${fmt(r.shares)}</td><td class="num">${fmt(r.avgCost, 2)}</td><td class="num">${fmt(r.price, 2)}</td><td class="num ${cls(r.changePct)}">${sign(r.changePct, 2, "%")}</td><td class="num">${fmt(r.marketValue)}</td><td class="num ${cls(r.pnl)}">${sign(r.pnl)}</td><td class="num ${cls(r.pnlPct)}">${sign(r.pnlPct, 2, "%")}</td><td>${dec[r.symbol] ? pill(dec[r.symbol].action) + ` <span class="muted small">${fmt(dec[r.symbol].score, 1)}</span>` : ""}</td></tr>`).join("") : '<tr><td colspan="10" class="muted">沒有持股。到「設定」輸入持股與現金。</td></tr>';
  $("#posNote").textContent = v ? `更新 ${lc.tTaipei}` : "";

  // 決策
  const decs = lc?.decisions || [];
  $("#decTable tbody").innerHTML = decs.length ? decs.map((d) => { const a = lc.analyses[d.symbol] || {}; return `<tr class="clickable" data-sym="${d.symbol}"><td>${d.symbol}</td><td>${esc(a.name)}</td><td class="num">${fmt(a.price, 2)}</td><td class="num ${cls(a.changePct)}">${sign(a.changePct, 2, "%")}</td><td>${scoreBar(d.score)}</td>${miniScores(a.analysts)}<td>${pill(d.action)}${d.result ? ` <span class="muted small">${esc(d.result)}</span>` : ""}</td><td class="num">${d.shares ? fmt(d.shares) : ""}</td><td class="wrap">${esc(d.reason)}</td></tr><tr class="sub clickable" data-sym="${d.symbol}"><td colspan="13"><div class="subtx">${pill(d.action)}${d.shares ? ` <b>${fmt(d.shares)} 股</b>` : ""}${d.result ? ` <span class="muted">${esc(d.result)}</span>` : ""} ${esc(d.reason)}</div></td></tr>`; }).join("") : '<tr><td colspan="13" class="muted">按上方「分析」產生訊號。</td></tr>';
  $("#decNote").textContent = lc ? `${lc.executed ? "已模擬下單" : "僅建議"} · ${lc.ai ? "AI：" + lc.ai.model : "規則引擎"} · 耗時 ${(lc.durationMs / 1000).toFixed(1)}s` : "";

  // 市場觀點
  $("#marketView").innerHTML = lc ? `${lc.ai ? `<p>${esc(lc.ai.market_view)}</p><p class="muted small">風險等級：${lc.ai.risk_level}</p>` : ""}${lc.aiError ? `<p class="small" style="color:var(--s2)">${esc(lc.aiError)}</p>` : ""}<p class="small">加權指數 ${fmt(idx?.price)} <span class="${cls(idx?.changePct)}">${sign(idx?.changePct, 2, "%")}</span>${lc.indices?.otc ? `，櫃買 ${fmt(lc.indices.otc.price)} <span class="${cls(lc.indices.otc.changePct)}">${sign(lc.indices.otc.changePct, 2, "%")}</span>` : ""}</p><p class="small">總經新聞情緒：<b class="${cls(lc.macroSentiment)}">${sign(lc.macroSentiment, 2)}</b>（-1 偏空 ～ +1 偏多，關鍵字法）</p>` : '<span class="muted">尚未執行分析。</span>';
  renderGlobal();
  $("#macroPoints").innerHTML = lc?.macro ? `<li><b>總經分析師 ${sign(lc.macro.score, 1)}</b> <span class="muted">${lc.macro.data?.regime || ""}</span></li>` + (lc.macro.points || []).map((x) => `<li>· ${esc(x)}</li>`).join("") : "";
  $("#macroNews").innerHTML = (lc?.macroNews || []).slice(0, 14).map(newsLi).join("") || '<li class="muted">--</li>';

  // 交易紀錄
  $("#tradeTable tbody").innerHTML = S.trades.length ? S.trades.slice(0, 60).map((t) => `<tr><td>${timeStr(t.t)}</td><td>${t.symbol}</td><td>${esc(t.name)}</td><td>${pill(t.side)}</td><td class="num">${fmt(t.shares)}</td><td class="num">${fmt(t.price, 2)}</td><td class="num">${fmt(t.fee + t.tax)}</td><td class="num ${cls(t.realized)}">${t.side === "SELL" ? sign(t.realized) : ""}</td><td>${t.source}</td><td class="wrap">${esc(t.reason)}</td></tr><tr class="sub"><td colspan="10"><div class="subtx">${esc(t.reason)}</div></td></tr>`).join("") : '<tr><td colspan="10" class="muted">尚無交易。</td></tr>';
  $("#tradeNote").textContent = `手續費 ${(S.config.fees.commission * 100).toFixed(4)}% × ${S.config.fees.discount} 折，最低 ${S.config.fees.minFee} 元；證交稅 ${(S.config.fees.tax * 100).toFixed(1)}%`;

  // 日誌
  $("#log").innerHTML = S.log.slice(0, 40).map((l) => `<li class="${l.level}">${timeStr(l.t)} ${esc(l.msg)}</li>`).join("");
}
// 側欄即時表：優先用 /api/live，抓不到時退回最近一輪分析的快照
function renderGlobal() {
  const lc = S?.lastCycle;
  const src = LIVE || { taifex: lc?.taifex, global: lc?.global, t: lc?.tTaipei, snapshot: true };
  const tf = src.taifex?.latest, g = src.global || {};
  const gRow = (x) => x?.price != null ? `<tr><td>${esc(x.label)}${x.session && x.session !== "futures" ? ` <span class="muted">${{ pre: "盤前", post: "盤後", regular: "盤中", closed: "收盤" }[x.session] || ""}</span>` : ""}</td><td class="num">${fmt(x.price, x.price < 1000 ? 2 : 0)}</td><td class="num ${cls(x.changePct)}">${sign(x.changePct, 2, "%")}</td></tr>` : "";
  $("#globalTable").innerHTML = (tf ? `<tr><td><b>台指期${tf.session === "night" ? "夜盤" : "日盤"}</b> <span class="muted">${esc(tf.time || "")}</span></td><td class="num">${fmt(tf.price)}</td><td class="num ${cls(tf.changePct)}">${sign(tf.changePct, 2, "%")}</td></tr><tr class="sub-note"><td colspan="3" class="muted small">對結算價 ${sign(tf.change)} 點，期現價差 ${sign(tf.basis)}，高 ${fmt(tf.high)} 低 ${fmt(tf.low)}，量 ${fmt(tf.volume)}</td></tr>` : "") +
    ["es", "nq", "sp500", "nasdaq", "sox", "vix", "tsm", "nvda", "aapl", "amd", "mu", "avgo", "usdtwd", "dxy", "us10y"].map((k) => gRow(g[k])).join("") || '<tr><td colspan="3" class="muted">--</td></tr>';
  const t = src.t ? String(src.t).replace(/^\d+\/\d+\/\d+ /, "").slice(0, 5) : "";
  $("#globalNote").textContent = src.snapshot ? (t ? `分析快照 ${t}` : "每分鐘更新，含盤前盤後") : `更新 ${t}，每分鐘自動更新`;
}
async function refreshLive() { try { LIVE = await api("/api/live"); } catch { LIVE = null; } if (S) renderGlobal(); }
const ANALYST_ORDER = ["technical", "fundamental", "chips", "macro", "sentiment"];
const miniScores = (an) => ANALYST_ORDER.map((k) => { const b = an?.[k]; return `<td class="num mini ${cls(b?.score)}" title="${b ? esc(b.points.slice(0, 3).join("\n")) : ""}">${b ? sign(b.score, 1) : "--"}</td>`; }).join("");
const pill = (a) => `<span class="pill ${a}">${{ BUY: "買進", SELL: "賣出", HOLD: "觀望" }[a] || a}</span>`;
function scoreBar(s) { const pct = Math.min(Math.abs(s) / 8, 1) * 50; const left = s >= 0 ? 50 : 50 - pct; return `<span class="score"><span class="bar"><i style="left:${left}%;width:${pct}%;background:${s >= 0 ? "var(--up)" : "var(--down)"}"></i></span>${sign(s, 1)}</span>`; }
const newsLi = (n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a><span class="sent ${cls(n.sentiment)}">${n.sentiment > 0 ? "▲偏多" : n.sentiment < 0 ? "▼偏空" : ""}</span><div class="meta">${esc(n.source)} · ${timeStr(n.pubDate)}</div></li>`;

// ---------- 動作 ----------
async function refresh() { S = await api("/api/state"); render(); }
async function runCycle(execute) {
  if (busy) return; setBusy(true); toast(execute ? "分析中，完成後將模擬下單…" : "分析中…", 8000);
  try { await api("/api/cycle", { execute }); await refresh(); const n = S.lastCycle?.trades?.length || 0; toast(execute ? `完成：模擬成交 ${n} 筆` : "分析完成"); }
  catch (e) { toast("失敗：" + e.message, 6000); }
  finally { setBusy(false); }
}
$("#btnAnalyze").onclick = () => runCycle(false);
$("#btnRun").onclick = () => runCycle(true);
$("#btnSettings").onclick = () => openSettings();
$$("[data-close]").forEach((b) => (b.onclick = () => b.closest(".drawer").classList.add("hidden")));
document.addEventListener("click", (e) => { const tr = e.target.closest("tr.clickable"); if (tr) openDetail(tr.dataset.sym); });

// ---------- 個股明細 ----------
async function openDetail(sym) {
  const d = $("#drawer"); d.classList.remove("hidden"); $("#dTitle").textContent = sym + " 載入中…"; $("#dBody").style.opacity = 0.4;
  try {
    const a = await api(`/api/symbol?code=${sym}`);
    const L = a.indicators || {}, q = a.quote || {};
    $("#dTitle").textContent = `${a.symbol} ${a.name}`;
    $("#dKpis").innerHTML = tile("現價", fmt(a.price, 2), `${sign(q.change, 2)} (${sign(q.changePct, 2, "%")}) ${q.time || ""}`, cls(q.change)) + tile("規則分數", sign(a.score, 1), a.ruleDecision ? "" : "") + tile("買/賣一", `${fmt(q.bestBid, 2)} / ${fmt(q.bestAsk, 2)}`) + tile("成交量", fmt(q.volume) + " 張", `量比 ${fmt(L.volRatio, 2)}`) + tile("新聞情緒", sign(a.sentiment?.score, 2), `${a.sentiment?.n || 0} 則`, cls(a.sentiment?.score));
    $("#dAnalysts").innerHTML = ANALYST_ORDER.map((k) => { const b = a.analysts?.[k]; if (!b) return ""; return `<div class="analyst"><div class="head"><span>${b.label}分析師</span><b class="${cls(b.score)}">${sign(b.score, 1)}</b></div><div class="conf">信心 ${fmt(b.confidence * 100, 0)}% · 權重 ${fmt(b.weight * 100, 0)}%</div><ul>${b.points.slice(0, 4).map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`; }).join("");
    const s = a.series;
    if (s) {
      const N = 120, sl = (arr) => arr.slice(-N);
      Chart.line($("#dPrice"), { x: sl(s.dates).map((x) => x.slice(5)), series: [{ name: "收盤", values: sl(s.close), color: CSS("--s1") }, { name: "MA20", values: sl(s.ma20), color: CSS("--s2"), width: 1.5 }, { name: "MA60", values: sl(s.ma60), color: CSS("--s3"), width: 1.5 }] });
      Chart.line($("#dRsi"), { x: sl(s.dates).map((x) => x.slice(5)), series: [{ name: "RSI14", values: sl(s.rsi14), color: CSS("--s7") }, { name: "K", values: sl(s.K), color: CSS("--s4"), width: 1.5 }], yMin: 0, yMax: 100, bands: [[30, 70]], legend: true });
    }
    const pairs = [["日期", L.date], ["MA5 / 10 / 20", `${fmt(L.ma5, 2)} / ${fmt(L.ma10, 2)} / ${fmt(L.ma20, 2)}`], ["MA60 / 120", `${fmt(L.ma60, 2)} / ${fmt(L.ma120, 2)}`], ["MA20 五日斜率", sign(L.ma20Slope, 2, "%")], ["RSI14", fmt(L.rsi14, 1)], ["MACD DIF / DEA / 柱", `${fmt(L.macdDif, 2)} / ${fmt(L.macdDea, 2)} / ${fmt(L.macdHist, 2)}`], ["KD", `${fmt(L.k, 1)} / ${fmt(L.d, 1)}`], ["布林上 / 下 / 位置", `${fmt(L.bbUpper, 2)} / ${fmt(L.bbLower, 2)} / ${fmt(L.bbPos, 0)}%`], ["ATR14", `${fmt(L.atr14, 2)} (${fmt(L.atrPct, 2)}%)`], ["20 日高 / 低", `${fmt(L.hi20, 2)} / ${fmt(L.lo20, 2)}`], ["5 / 20 / 60 日報酬", `${sign(L.ret5, 1, "%")} / ${sign(L.ret20, 1, "%")} / ${sign(L.ret60, 1, "%")}`]];
    $("#dInd").innerHTML = pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    $("#dReasons").innerHTML = (a.reasons || []).map((r) => `<li>· ${esc(r)}</li>`).join("") || "<li class='muted'>--</li>";
    $("#dNews").innerHTML = (a.news || []).map(newsLi).join("") || "<li class='muted'>沒有找到新聞</li>";
    const f = $("#orderForm"); f.dataset.sym = sym; const held = S.positions[sym]?.shares || 0; f.shares.value = held && held < 1000 ? held : 1000;
  } catch (e) { $("#dTitle").textContent = "載入失敗：" + e.message; }
  finally { $("#dBody").style.opacity = 1; }
}
$("#orderForm").onsubmit = async (e) => {
  e.preventDefault(); const f = e.target;
  try { const r = await api("/api/order", { symbol: f.dataset.sym, side: f.side.value, shares: Number(f.shares.value) }); toast(`成交：${r.trade.side} ${r.trade.symbol} ${r.trade.shares} 股 @ ${r.trade.price}`); await refresh(); }
  catch (err) { toast("下單失敗：" + err.message, 5000); }
};

// ---------- 設定 ----------
function posRow(p = {}) { return `<tr><td><input name="psym" value="${esc(p.symbol || "")}" placeholder="2330" size="6"></td><td><input name="pshares" type="number" value="${p.shares || ""}" placeholder="1000"></td><td><input name="pcost" type="number" step="0.01" value="${p.avgCost ? (+p.avgCost).toFixed(2) : ""}" placeholder="成本/股"></td><td><button type="button" class="btn ghost" data-del>✕</button></td></tr>`; }
function openSettings() {
  const f = $("#setupForm"), c = S.config, r = c.risk;
  f.cash.value = Math.round(S.cash);
  $("#posEdit tbody").innerHTML = Object.entries(S.positions).map(([symbol, p]) => posRow({ symbol, ...p })).join("") || posRow();
  renderChips();
  for (const k of ["maxPositionPct", "perTradePct", "stopLossPct", "takeProfitPct", "minCashPct"]) f[k].value = +(r[k] * 100).toFixed(2);
  for (const k of ["buyThreshold", "sellThreshold", "maxPositions", "cooldownDays", "minOrderAmount"]) f[k].value = r[k];
  f.oddLot.checked = !!r.oddLot;
  for (const k of ANALYST_ORDER) f["w_" + k].value = Math.round((c.weights?.[k] ?? 0) * 100);
  f.autoEnabled.checked = !!c.auto.enabled; f.intervalMin.value = c.auto.intervalMin; f.executeOnClose.checked = !!c.auto.executeOnClose;
  f.aiEnabled.checked = !!c.ai.enabled; f.aiModel.value = c.ai.model; f.aiEffort.value = c.ai.effort;
  $("#settings").classList.remove("hidden");
}
let watch = [];
function renderChips() { watch = [...S.config.watchlist]; drawChips(); }
function drawChips() { $("#watchChips").innerHTML = watch.map((s) => `<span class="chip">${s}<b data-rm="${s}">✕</b></span>`).join(""); }
$("#watchChips").onclick = (e) => { const s = e.target.dataset.rm; if (s) { watch = watch.filter((x) => x !== s); drawChips(); } };
let sugT = null;
$("#watchInput").oninput = (e) => { clearTimeout(sugT); const q = e.target.value.trim(); if (!q) return ($("#watchSuggest").innerHTML = ""); sugT = setTimeout(async () => { const list = await api(`/api/search?q=${encodeURIComponent(q)}`); $("#watchSuggest").innerHTML = list.map((s) => `<div data-add="${s.code}">${s.code} ${esc(s.name)} <span class="muted small">${s.market}</span></div>`).join(""); }, 250); };
$("#watchSuggest").onclick = (e) => { const c = e.target.closest("[data-add]")?.dataset.add; if (c) { if (!watch.includes(c)) watch.push(c); drawChips(); $("#watchSuggest").innerHTML = ""; $("#watchInput").value = ""; } };
$("#btnTune").onclick = async () => {
  if (!confirm("自動調參會用回測結果覆蓋：停損、停利、買進／賣出門檻、每筆買進比例、單一持股上限、冷卻天數（你手動設定的停損會被改掉）。確定要執行？")) return;
  const b = $("#btnTune"); b.disabled = true; $("#tuneResult").textContent = "回測中，約 10～60 秒…";
  try {
    const r = await api("/api/tune", { apply: true });
    S = r.state; openSettings();
    const pct = (v) => Math.round(v * 100);
    $("#tuneResult").innerHTML = `已套用：買進門檻 ${r.best.risk.buyThreshold}、賣出 ${r.best.risk.sellThreshold}、停損 ${pct(r.best.risk.stopLossPct)}%、停利 ${pct(r.best.risk.takeProfitPct)}%、每次買進 ${pct(r.best.risk.perTradePct)}%、冷卻 ${r.best.risk.cooldownDays} 天。回測 ${r.tried} 組：最佳報酬 <b class="${cls(r.best.returnPct)}">${sign(r.best.returnPct, 1, "%")}</b>（回撤 ${r.best.maxDrawdownPct}%），原參數 ${sign(r.current.returnPct, 1, "%")}，0050 同期 ${sign(r.best.benchmarkReturnPct, 1, "%")}`;
    toast("風控參數已自動調整"); render();
  } catch (e) { $("#tuneResult").textContent = "失敗：" + e.message; }
  finally { b.disabled = false; }
};
$("#addPosRow").onclick = () => $("#posEdit tbody").insertAdjacentHTML("beforeend", posRow());
$("#posEdit").onclick = (e) => { if (e.target.dataset.del != null) e.target.closest("tr").remove(); };
$("#btnReset").onclick = async () => {
  const f = $("#setupForm");
  const positions = $$("#posEdit tbody tr").map((tr) => ({ symbol: tr.querySelector("[name=psym]").value.trim(), shares: Number(tr.querySelector("[name=pshares]").value), avgCost: Number(tr.querySelector("[name=pcost]").value) })).filter((p) => p.symbol && p.shares > 0);
  if (!confirm(`將以現金 ${fmt(f.cash.value)} 與 ${positions.length} 檔持股重設帳戶，並清空交易紀錄與資產曲線。確定？`)) return;
  try { S = await api("/api/portfolio/reset", { cash: Number(f.cash.value), positions }); await saveSettings(); toast("帳戶已重設"); render(); }
  catch (e) { toast("重設失敗：" + e.message, 5000); }
};
async function saveSettings() {
  const f = $("#setupForm");
  const pct = (k) => Number(f[k].value) / 100;
  const wsum = ANALYST_ORDER.reduce((t, k) => t + Number(f["w_" + k].value || 0), 0) || 1;
  const weights = Object.fromEntries(ANALYST_ORDER.map((k) => [k, Number(f["w_" + k].value || 0) / wsum]));
  const body = { watchlist: watch, weights, risk: { maxPositionPct: pct("maxPositionPct"), perTradePct: pct("perTradePct"), stopLossPct: pct("stopLossPct"), takeProfitPct: pct("takeProfitPct"), minCashPct: pct("minCashPct"), buyThreshold: Number(f.buyThreshold.value), sellThreshold: Number(f.sellThreshold.value), maxPositions: Number(f.maxPositions.value), cooldownDays: Number(f.cooldownDays.value), minOrderAmount: Number(f.minOrderAmount.value), oddLot: f.oddLot.checked }, auto: { enabled: f.autoEnabled.checked, intervalMin: Number(f.intervalMin.value), executeOnClose: f.executeOnClose.checked }, ai: { enabled: f.aiEnabled.checked, model: f.aiModel.value.trim(), effort: f.aiEffort.value } };
  S = await api("/api/config", body);
}
$("#setupForm").onsubmit = async (e) => { e.preventDefault(); try { await saveSettings(); toast("設定已儲存"); $("#settings").classList.add("hidden"); render(); } catch (err) { toast("儲存失敗：" + err.message, 5000); } };

// ---------- 回測 ----------
$("#btForm").onsubmit = async (e) => {
  e.preventDefault(); const f = e.target; const btn = f.querySelector("button"); btn.disabled = true; toast("回測中（首次需下載歷史資料，約需 10-60 秒）…", 10000);
  try {
    const r = await api("/api/backtest", { symbols: f.symbols.value.split(/[,，\s]+/).filter(Boolean), cash: Number(f.cash.value), days: Number(f.days.value), risk: S.config.risk, fees: S.config.fees });
    $("#btChart").classList.remove("hidden"); $("#btTrades").classList.remove("hidden");
    $("#btStats").innerHTML = tile("期末資產", fmt(r.finalEquity), `${r.start} ～ ${r.end}`) + tile("策略報酬", sign(r.returnPct, 2, "%"), "", cls(r.returnPct)) + tile(`${r.benchmark} 同期`, sign(r.benchmarkReturnPct, 2, "%"), "買進持有", cls(r.benchmarkReturnPct)) + tile("最大回撤", "-" + fmt(r.maxDrawdownPct, 2) + "%", "", "down") + tile("交易次數", r.trades, `賣出 ${r.sells} 筆，勝率 ${fmt(r.winRate, 1)}%`) + tile("已實現", sign(r.realized), "", cls(r.realized));
    Chart.line($("#btChart"), { x: r.curve.map((p) => p.date.slice(5)), series: [{ name: "策略", values: r.curve.map((p) => p.total), color: CSS("--s1") }, { name: r.benchmark + " 買進持有", values: r.curve.map((p) => p.benchmark), color: CSS("--muted"), width: 1.5, dashed: true }], baseline: r.initialCash });
    $("#btTrades tbody").innerHTML = r.tradeLog.slice(0, 80).map((t) => `<tr><td>${t.t}</td><td>${t.symbol}</td><td>${pill(t.side)}</td><td class="num">${fmt(t.shares)}</td><td class="num">${fmt(t.price, 2)}</td><td class="num ${cls(t.realized)}">${t.side === "SELL" ? sign(t.realized) : ""}</td><td class="wrap">${esc(t.reason)}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">期間內沒有交易</td></tr>';
    toast("回測完成");
  } catch (err) { toast("回測失敗：" + err.message, 6000); }
  finally { btn.disabled = false; }
};

// ---------- 啟動 ----------
refresh().then(() => { const m = location.hash.match(/sym=(\d{4,6})/); if (m) openDetail(m[1]); else if (location.hash === "#settings") openSettings(); else if (!Object.keys(S.positions).length && !S.equity.length) openSettings(); }).catch((e) => toast("無法連線伺服器：" + e.message));
setInterval(() => { if (!busy) refresh().catch(() => {}); }, 60 * 1000);
refreshLive();
setInterval(refreshLive, 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLive(); });
window.addEventListener("resize", () => render());


// ---------- 投資長對話 ----------
const chatLog = $("#chatLog"), chatInput = $("#chatInput");
let chatBusy = false, chatLoaded = false;
/** 極簡 markdown：粗體、條列、段落；先跳脫再轉換 */
function md(text) {
  const lines = esc(text).split("\n");
  let out = "", inList = false;
  for (const ln of lines) {
    const m = ln.match(/^\s*(?:[-*•]|\d+[.、])\s+(.*)$/);
    if (m) { if (!inList) { out += "<ul>"; inList = true; } out += `<li>${m[1]}</li>`; continue; }
    if (inList) { out += "</ul>"; inList = false; }
    out += ln + "\n";
  }
  if (inList) out += "</ul>";
  return out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>").replace(/\n{2,}/g, "\n\n");
}
function chatBubble(role, text, meta) {
  const d = document.createElement("div"); d.className = "msg " + role;
  if (role === "assistant") d.innerHTML = md(text); else d.textContent = text;
  if (meta) { const m = document.createElement("span"); m.className = "meta"; m.textContent = meta; d.appendChild(m); }
  chatLog.appendChild(d); chatLog.scrollTop = chatLog.scrollHeight; return d;
}
const chatMeta = (m) => `${m.t ? timeStr(m.t) : ""}${m.usage ? ` · ${m.usage.in + (m.usage.cached || 0)}→${m.usage.out} tokens${m.usage.cached ? "（快取 " + m.usage.cached + "）" : ""}` : ""}`;
async function openChat() {
  $("#chat").classList.remove("hidden");
  if (!chatLoaded) {
    chatLoaded = true;
    try {
      const r = await api("/api/chat");
      chatLog.innerHTML = "";
      if (!r.aiAvailable) $("#chatHint").textContent = "找不到 ANTHROPIC_API_KEY，對話功能無法使用。";
      for (const m of r.messages) chatBubble(m.role, m.content, chatMeta(m));
      if (!r.messages.length) chatBubble("assistant", "我是投資長。想知道委員會為什麼這樣判斷、或你在考慮的操作，直接問。");
    } catch (e) { toast("讀取對話失敗：" + e.message); }
  }
  setTimeout(() => chatInput.focus(), 50);
}
$("#btnChat").onclick = openChat;
$("#chatClear").onclick = async () => { if (!confirm("清空和投資長的對話？")) return; await api("/api/chat/clear", {}); chatLog.innerHTML = ""; chatBubble("assistant", "對話已清空。"); };
chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chatForm").requestSubmit(); } });
$("#chatForm").onsubmit = async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim(); if (!text || chatBusy) return;
  chatBusy = true; $("#chatSend").disabled = true; chatInput.value = "";
  chatBubble("user", text, timeStr(new Date().toISOString()));
  const bubble = chatBubble("assistant", ""); bubble.classList.add("typing");
  let acc = "";
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) });
    if (r.status === 401) { location.href = "/login.html"; return; }
    if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText); }
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.delta) { acc += ev.delta; bubble.innerHTML = md(acc); chatLog.scrollTop = chatLog.scrollHeight; }
        else if (ev.error) throw new Error(ev.error);
        else if (ev.done) { bubble.innerHTML = md(acc); const m = document.createElement("span"); m.className = "meta"; m.textContent = chatMeta({ t: new Date().toISOString(), usage: ev.usage && { in: ev.usage.input_tokens, out: ev.usage.output_tokens, cached: ev.usage.cache_read_input_tokens } }); bubble.appendChild(m); }
      }
    }
    if (!acc) throw new Error("沒有收到回覆");
  } catch (err) { bubble.textContent = "（失敗：" + err.message + "）"; }
  finally { bubble.classList.remove("typing"); chatBusy = false; $("#chatSend").disabled = false; chatLog.scrollTop = chatLog.scrollHeight; }
};
if (location.hash === "#chat") openChat();
