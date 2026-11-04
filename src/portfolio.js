// 紙上交易帳本：手續費、證交稅、持股成本、損益計算

export function calcFees(side, amount, fees) {
  let fee = Math.round(amount * fees.commission * (fees.discount ?? 1));
  if (fee < fees.minFee) fee = fees.minFee;
  const tax = side === "SELL" ? Math.round(amount * fees.tax) : 0;
  return { fee, tax };
}

// ---------- 融資 ----------
// 台灣規則：上市融資六成、上櫃五成（自備四／五成），融資金額以千元為單位無條件捨去，只能整張；
// 利息按日計（年利率 / 365）；整戶維持率 = 融資擔保品市值 / 融資金額，低於 130% 追繳，兩日內未補就斷頭。
export const DEFAULT_MARGIN = { enabled: false, ratioTse: 0.6, ratioOtc: 0.5, interestRate: 0.065, maintenance: 1.3, forceSell: true };
export const marginRatio = (market, cfg = DEFAULT_MARGIN) => (market === "otc" ? cfg.ratioOtc : cfg.ratioTse);

/** 融資利息按日累計到 pos.interest（賣出時扣）；now 可給毫秒或日期字串（回測） */
export function accrueInterest(state, now = Date.now()) {
  const rate = state.config.margin?.interestRate ?? DEFAULT_MARGIN.interestRate;
  const t = typeof now === "number" ? now : new Date(now).getTime();
  let added = 0;
  for (const pos of Object.values(state.positions)) {
    if (!(pos.loan > 0)) { delete pos.interestAt; continue; }
    if (!pos.interestAt) { pos.interestAt = t; continue; }
    const days = (t - pos.interestAt) / 86400e3;
    if (days < 1) continue;
    const i = (pos.loan * rate * Math.floor(days)) / 365;
    pos.interest = +((pos.interest || 0) + i).toFixed(2);
    pos.interestAt += Math.floor(days) * 86400e3;
    added += i;
  }
  return Math.round(added);
}

/** 執行一筆模擬成交，直接修改 state。回傳成交紀錄或錯誤。margin=true 時以 ratio 成數融資買進（只能整張）。 */
export function executeOrder(state, { symbol, side, shares, price, name, reason = "", source = "manual", margin = false, ratio = 0, at = null }) {
  const now = at ? new Date(at).getTime() : Date.now();
  shares = Math.floor(Number(shares));
  price = Number(price);
  if (!symbol || !(shares > 0) || !(price > 0)) return { error: "參數錯誤" };
  const fees = state.config.fees;
  const amount = +(shares * price).toFixed(0);
  const { fee, tax } = calcFees(side, amount, fees);
  const pos = state.positions[symbol] || { shares: 0, avgCost: 0, name: name || "" };
  if (name) pos.name = name;
  let realized = 0, loan = 0, interest = 0;
  if (side === "BUY") {
    if (margin && ratio > 0) {
      if (shares % 1000) return { error: "融資只能整張（1000 股的倍數）" };
      loan = Math.floor((amount * ratio) / 1000) * 1000;
    }
    const total = amount + fee;
    const outlay = total - loan;
    if (outlay > state.cash) return { error: `現金不足：需要${loan ? "自備款" : ""} ${outlay.toLocaleString()}，現有 ${Math.round(state.cash).toLocaleString()}` };
    const newShares = pos.shares + shares;
    pos.avgCost = (pos.avgCost * pos.shares + total) / newShares;
    pos.shares = newShares;
    if (loan) { pos.loan = (pos.loan || 0) + loan; pos.interestAt = pos.interestAt || now; }
    state.cash -= outlay;
  } else if (side === "SELL") {
    if (shares > pos.shares) return { error: `持股不足：持有 ${pos.shares} 股，欲賣 ${shares} 股` };
    if (pos.loan > 0) { // 依賣出比例償還融資與利息
      loan = Math.round((pos.loan * shares) / pos.shares);
      interest = +(((pos.interest || 0) * shares) / pos.shares).toFixed(0);
      pos.loan -= loan; pos.interest = +((pos.interest || 0) - interest).toFixed(2);
      if (pos.loan <= 0) { pos.loan = 0; pos.interest = 0; delete pos.interestAt; }
    }
    const net = amount - fee - tax - interest;
    realized = net - pos.avgCost * shares;
    pos.shares -= shares;
    state.cash += net - loan;
  } else return { error: "side 需為 BUY 或 SELL" };
  if (pos.shares === 0) delete state.positions[symbol];
  else state.positions[symbol] = pos;
  const trade = { t: new Date(now).toISOString(), symbol, name: pos.name, side, shares, price, fee, tax, amount, realized: +realized.toFixed(0), reason, source, ...(loan ? { loan, margin: true } : {}), ...(interest ? { interest } : {}) };
  state.trades.unshift(trade);
  if (state.trades.length > 2000) state.trades.length = 2000;
  return { trade };
}

/** 估值：總資產 = 現金 + 持股市值 − 融資餘額 − 未付利息；整戶維持率 = 融資持股市值 / 融資餘額 */
export function valuation(state, quotes) {
  let marketValue = 0, cost = 0, dayPnl = 0, loan = 0, interest = 0, collateral = 0;
  const rows = [];
  for (const [symbol, pos] of Object.entries(state.positions)) {
    const q = quotes[symbol];
    const price = q?.price ?? pos.lastPrice ?? pos.avgCost;
    if (q?.price != null) pos.lastPrice = q.price;
    const mv = pos.shares * price;
    const pnl = mv - pos.avgCost * pos.shares - (pos.interest || 0);
    const dp = q?.change != null ? q.change * pos.shares : 0;
    marketValue += mv; cost += pos.avgCost * pos.shares; dayPnl += dp;
    const ln = pos.loan || 0;
    if (ln > 0) { loan += ln; interest += pos.interest || 0; collateral += mv; }
    rows.push({ symbol, name: q?.name || pos.name, shares: pos.shares, avgCost: +pos.avgCost.toFixed(2), price, marketValue: Math.round(mv), pnl: Math.round(pnl), pnlPct: pos.avgCost ? +((pnl / (pos.avgCost * pos.shares)) * 100).toFixed(2) : null, dayPnl: Math.round(dp), changePct: q?.changePct ?? null,
      loan: Math.round(ln), interest: Math.round(pos.interest || 0), maintenance: ln > 0 ? +((mv / ln) * 100).toFixed(1) : null });
  }
  const total = state.cash + marketValue - loan - interest;
  const realized = state.trades.reduce((s, t) => s + (t.realized || 0), 0);
  const base = state.initialEquity ?? state.config.initialCash;
  const mcfg = state.config.margin || DEFAULT_MARGIN;
  const maintenance = loan > 0 ? +((collateral / loan) * 100).toFixed(1) : null;
  return { rows, cash: Math.round(state.cash), marketValue: Math.round(marketValue), total: Math.round(total), unrealized: Math.round(marketValue - cost - interest), dayPnl: Math.round(dayPnl), realized: Math.round(realized), initialEquity: base, returnPct: base ? +(((total - base) / base) * 100).toFixed(2) : null,
    loan: Math.round(loan), interest: Math.round(interest), maintenance, marginCall: maintenance != null && maintenance < mcfg.maintenance * 100, maintenanceLine: Math.round(mcfg.maintenance * 100) };
}
