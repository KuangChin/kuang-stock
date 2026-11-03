// 技術指標：輸入日線陣列（舊 -> 新），輸出序列與最新值
const last = (a) => (a.length ? a[a.length - 1] : null);
const r2 = (v) => (v == null ? null : +v.toFixed(2));

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    if (i >= n - 1) out[i] = prev;
  }
  return out;
}

export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) {
        gain /= n; loss /= n;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const dif = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const valid = dif.map((v) => v ?? 0);
  const firstIdx = dif.findIndex((v) => v != null);
  const dea = new Array(closes.length).fill(null);
  const k = 2 / (signal + 1);
  let prev = null;
  for (let i = firstIdx; i >= 0 && i < closes.length; i++) {
    prev = prev == null ? valid[i] : valid[i] * k + prev * (1 - k);
    if (i >= firstIdx + signal - 1) dea[i] = prev;
  }
  const hist = dif.map((v, i) => (v != null && dea[i] != null ? v - dea[i] : null));
  return { dif, dea, hist };
}

/** 台股常用 KD(9,3,3) */
export function kd(bars, n = 9) {
  const K = new Array(bars.length).fill(null), D = new Array(bars.length).fill(null);
  let k = 50, d = 50;
  for (let i = n - 1; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); }
    const rsv = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    K[i] = k; D[i] = d;
  }
  return { K, D };
}

export function bollinger(closes, n = 20, mult = 2) {
  const mid = sma(closes, n);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper.push(mid[i] + mult * sd); lower.push(mid[i] - mult * sd);
  }
  return { mid, upper, lower };
}

export function atr(bars, n = 14) {
  const tr = bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
  return sma(tr, n);
}

/** 整合計算，回傳最新值摘要與序列（供圖表） */
export function computeIndicators(bars) {
  if (!bars || bars.length < 2) return null;
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume ?? 0);
  const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20), ma60 = sma(closes, 60), ma120 = sma(closes, 120);
  const rsi14 = rsi(closes, 14);
  const m = macd(closes);
  const { K, D } = kd(bars);
  const bb = bollinger(closes);
  const atr14 = atr(bars);
  const vol20 = sma(vols, 20);
  const n = bars.length - 1, p = n - 1;
  const cross = (a, b, i) => (a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null ? (a[i - 1] <= b[i - 1] && a[i] > b[i] ? 1 : a[i - 1] >= b[i - 1] && a[i] < b[i] ? -1 : 0) : 0);
  const hi20 = Math.max(...bars.slice(-20).map((b) => b.high));
  const lo20 = Math.min(...bars.slice(-20).map((b) => b.low));
  const hi60 = Math.max(...bars.slice(-60).map((b) => b.high));
  const lo60 = Math.min(...bars.slice(-60).map((b) => b.low));
  const ret = (k) => (bars.length > k ? r2(((closes[n] - closes[n - k]) / closes[n - k]) * 100) : null);
  const latest = {
    date: bars[n].date,
    close: closes[n],
    ma5: r2(ma5[n]), ma10: r2(ma10[n]), ma20: r2(ma20[n]), ma60: r2(ma60[n]), ma120: r2(ma120[n]),
    ma20Slope: ma20[n] != null && ma20[n - 5] != null ? r2(((ma20[n] - ma20[n - 5]) / ma20[n - 5]) * 100) : null,
    rsi14: r2(rsi14[n]),
    macdDif: r2(m.dif[n]), macdDea: r2(m.dea[n]), macdHist: r2(m.hist[n]), macdHistPrev: r2(m.hist[p]),
    k: r2(K[n]), d: r2(D[n]), kdCross: cross(K, D, n),
    ma5x20: cross(ma5, ma20, n),
    bbUpper: r2(bb.upper[n]), bbLower: r2(bb.lower[n]),
    bbPos: bb.upper[n] != null && bb.upper[n] !== bb.lower[n] ? r2(((closes[n] - bb.lower[n]) / (bb.upper[n] - bb.lower[n])) * 100) : null,
    atr14: r2(atr14[n]),
    atrPct: atr14[n] != null ? r2((atr14[n] / closes[n]) * 100) : null,
    volume: vols[n], vol20: r2(vol20[n]),
    volRatio: vol20[n] ? r2(vols[n] / vol20[n]) : null,
    hi20, lo20, hi60, lo60,
    ret5: ret(5), ret20: ret(20), ret60: ret(60),
    bars: bars.length,
  };
  return {
    latest,
    series: {
      dates: bars.map((b) => b.date),
      close: closes,
      volume: vols,
      ma5, ma20, ma60,
      rsi14,
      macdDif: m.dif, macdDea: m.dea, macdHist: m.hist,
      K, D,
      bbUpper: bb.upper, bbLower: bb.lower,
    },
  };
}
