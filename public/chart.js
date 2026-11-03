// 極簡 SVG 折線圖：多序列、Y 格線、十字游標 + tooltip、直接標籤
window.Chart = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
  const fmtDefault = (v) => (Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + "萬" : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const niceTicks = (lo, hi, n = 4) => {
    if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; }
    const span = hi - lo, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10)); return out;
  };

  function line(container, { x, series, yFormat = fmtDefault, legend = true, baseline = null, yMin = null, yMax = null, bands = null }) {
    container.innerHTML = "";
    const W = container.clientWidth || 600, H = container.clientHeight || 240;
    const P = { l: 54, r: 14, t: legend ? 22 : 10, b: 24 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}` }, container);
    const vals = series.flatMap((s) => s.values).filter((v) => v != null && Number.isFinite(v));
    if (!vals.length) { container.innerHTML = '<div class="muted small" style="padding:20px">尚無資料</div>'; return; }
    let lo = yMin ?? Math.min(...vals), hi = yMax ?? Math.max(...vals);
    if (baseline != null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
    const pad = (hi - lo) * 0.06 || 1; if (yMin == null) lo -= pad; if (yMax == null) hi += pad;
    const n = x.length;
    const sx = (i) => P.l + (n > 1 ? (i / (n - 1)) * (W - P.l - P.r) : (W - P.l - P.r) / 2);
    const sy = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    // bands（例如 RSI 30/70 區）
    if (bands) for (const b of bands) el("rect", { x: P.l, y: sy(b[1]), width: W - P.l - P.r, height: sy(b[0]) - sy(b[1]), fill: "var(--neutral)", opacity: 0.6 }, svg);
    // Y 格線
    for (const t of niceTicks(lo, hi)) {
      el("line", { x1: P.l, x2: W - P.r, y1: sy(t), y2: sy(t), stroke: "var(--grid)", "stroke-width": 1 }, svg);
      const tx = el("text", { x: P.l - 6, y: sy(t) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, svg); tx.textContent = yFormat(t);
    }
    if (baseline != null) el("line", { x1: P.l, x2: W - P.r, y1: sy(baseline), y2: sy(baseline), stroke: "var(--axis)", "stroke-width": 1, "stroke-dasharray": "4 3" }, svg);
    // X 標籤
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - P.l - P.r) / 90))));
    for (let i = 0; i < n; i += step) { const tx = el("text", { x: sx(i), y: H - 6, "text-anchor": i === 0 ? "start" : "middle", "font-size": 11, fill: "var(--muted)" }, svg); tx.textContent = x[i]; }
    // 序列
    series.forEach((s) => {
      let d = "", started = false;
      s.values.forEach((v, i) => { if (v == null || !Number.isFinite(v)) { started = false; return; } d += (started ? "L" : "M") + sx(i).toFixed(1) + " " + sy(v).toFixed(1); started = true; });
      const pts = s.values.filter((v) => v != null && Number.isFinite(v));
      if (pts.length === 1) { const i = s.values.findIndex((v) => v != null); el("circle", { cx: sx(i), cy: sy(pts[0]), r: 4, fill: s.color }, svg); }
      el("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dashed ? "5 4" : "" }, svg);
      if (s.label !== false && (series.length === 1 || !legend)) { const li = s.values.map((v, i) => [v, i]).filter(([v]) => v != null).pop(); if (li) { const t = el("text", { x: sx(li[1]) - 4, y: sy(li[0]) - 6, "text-anchor": "end", "font-size": 11, fill: "var(--ink-2)" }, svg); t.textContent = s.name; } }
    });
    if (legend && series.length > 1) { const lg = document.createElement("div"); lg.className = "legend"; lg.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join(""); container.appendChild(lg); }
    // 十字游標 + tooltip
    const cross = el("line", { y1: P.t, y2: H - P.b, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" }, svg);
    const dots = series.map((s) => el("circle", { r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }, svg));
    const tip = document.createElement("div"); tip.className = "tip hidden"; container.appendChild(tip);
    const hit = el("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (ev) => {
      const r = container.getBoundingClientRect(); const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (n - 1))));
      cross.setAttribute("x1", sx(i)); cross.setAttribute("x2", sx(i)); cross.setAttribute("visibility", "visible");
      let html = `<div class="muted">${x[i]}</div>`;
      series.forEach((s, k) => { const v = s.values[i]; if (v == null) { dots[k].setAttribute("visibility", "hidden"); return; } dots[k].setAttribute("cx", sx(i)); dots[k].setAttribute("cy", sy(v)); dots[k].setAttribute("visibility", "visible"); html += `<div><i class="sw" style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${s.color};margin-right:6px"></i>${s.name} <b>${yFormat(v)}</b></div>`; });
      tip.innerHTML = html; tip.classList.remove("hidden");
      const left = (sx(i) / W) * r.width; tip.style.left = (left > r.width / 2 ? left - tip.offsetWidth - 12 : left + 12) + "px"; tip.style.top = Math.max(0, ((ev.clientY - r.top) / r.height) * r.height - 30) + "px";
    });
    hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); tip.classList.add("hidden"); });
  }
  return { line };
})();
