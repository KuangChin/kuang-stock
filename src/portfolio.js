// 紙上交易帳本：手續費、證交稅、持股成本、損益計算

export function calcFees(side, amount, fees) {
  let fee = Math.round(amount * fees.commission * (fees.discount ?? 1));
  if (fee < fees.minFee) fee = fees.minFee;
  const tax = side === "SELL" ? Math.round(amount * fees.tax) : 0;
  return { fee, tax };
}

/** 執行一筆模擬成交，直接修改 state。回傳成交紀錄或錯誤。 */
export function executeOrder(state, { symbol, side, shares, price, name, reason = "", source = "manual" }) {
  shares = Math.floor(Number(shares));
  price = Number(price);
  if (!symbol || !(shares > 0) || !(price > 0)) return { error: "參數錯誤" };
  const fees = state.config.fees;
  const amount = +(shares * price).toFixed(0);
  const { fee, tax } = calcFees(side, amount, fees);
  const pos = state.positions[symbol] || { shares: 0, avgCost: 0, name: name || "" };
  if (name) pos.name = name;
  let realized = 0;
  if (side === "BUY") {
    const total = amount + fee;
    if (total > state.cash) return { error: `現金不足：需要 ${total.toLocaleString()}，現有 ${Math.round(state.cash).toLocaleString()}` };
    const newShares = pos.shares + shares;
    pos.avgCost = (pos.avgCost * pos.shares + total) / newShares;
    pos.shares = newShares;
    state.cash -= total;
  } else if (side === "SELL") {
    if (shares > pos.shares) return { error: `持股不足：持有 ${pos.shares} 股，欲賣 ${shares} 股` };
    const net = amount - fee - tax;
    realized = net - pos.avgCost * shares;
    pos.shares -= shares;
    state.cash += net;
  } else return { error: "side 需為 BUY 或 SELL" };
  if (pos.shares === 0) delete state.positions[symbol];
  else state.positions[symbol] = pos;
  const trade = { t: new Date().toISOString(), symbol, name: pos.name, side, shares, price, fee, tax, amount, realized: +realized.toFixed(0), reason, source };
  state.trades.unshift(trade);
  if (state.trades.length > 2000) state.trades.length = 2000;
  return { trade };
}

export function valuation(state, quotes) {
  let marketValue = 0, cost = 0, dayPnl = 0;
  const rows = [];
  for (const [symbol, pos] of Object.entries(state.positions)) {
    const q = quotes[symbol];
    const price = q?.price ?? pos.lastPrice ?? pos.avgCost;
    if (q?.price != null) pos.lastPrice = q.price;
    const mv = pos.shares * price;
    const pnl = mv - pos.avgCost * pos.shares;
    const dp = q?.change != null ? q.change * pos.shares : 0;
    marketValue += mv; cost += pos.avgCost * pos.shares; dayPnl += dp;
    rows.push({ symbol, name: q?.name || pos.name, shares: pos.shares, avgCost: +pos.avgCost.toFixed(2), price, marketValue: Math.round(mv), pnl: Math.round(pnl), pnlPct: pos.avgCost ? +((pnl / (pos.avgCost * pos.shares)) * 100).toFixed(2) : null, dayPnl: Math.round(dp), changePct: q?.changePct ?? null });
  }
  const total = state.cash + marketValue;
  const realized = state.trades.reduce((s, t) => s + (t.realized || 0), 0);
  const base = state.initialEquity ?? state.config.initialCash;
  return { rows, cash: Math.round(state.cash), marketValue: Math.round(marketValue), total: Math.round(total), unrealized: Math.round(marketValue - cost), dayPnl: Math.round(dayPnl), realized: Math.round(realized), initialEquity: base, returnPct: base ? +(((total - base) / base) * 100).toFixed(2) : null };
}
