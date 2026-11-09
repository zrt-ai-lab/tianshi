/**
 * 天市 · 历史数据包与时点切片
 *
 * 回测的正确做法：每只股票**只抓一次全量**，然后本地按任意时点切片。
 * 绝不能在循环里反复请求（会被限流，也慢），更不能让切片碰到 asof 之后的数据。
 */

import { fetchKline, fetchValuationRows, fetchFundFlowRows, fetchFinancialsList } from './sources/eastmoney.mjs';

const norm = (c) => String(c).replace(/^(sh|sz|bj)/i, '');
const pct = (a, b) => (a === null || b === null || !b ? null : Number((((a - b) / b) * 100).toFixed(2)));

/**
 * 一次性取回某只股票的回测用全量数据。
 * @returns {{symbol:string, name:string|null, kline:object[], valuationRows:object[], fundflowRows:object[], financialsList:object[], evidence:object[]}}
 */
export async function fetchBag(code, { rootDir = '.', now = new Date() } = {}) {
  const symbol = norm(code);
  const [kl, val, ff, fin] = await Promise.all([
    fetchKline(symbol, { rootDir, now, lmt: 6000 }).catch((e) => ({ data: null, evidence: null, err: e })),
    fetchValuationRows(symbol, { rootDir, now }).catch((e) => ({ data: null, evidence: null, err: e })),
    fetchFundFlowRows(symbol, { rootDir, now }).catch((e) => ({ data: null, evidence: null, err: e })),
    fetchFinancialsList(symbol, { rootDir, now }).catch((e) => ({ data: null, evidence: null, err: e })),
  ]);

  const evidence = [kl, val, ff, fin].map((r) => r.evidence).filter(Boolean);
  if (!kl.data || kl.data.length === 0) throw new Error(`${symbol}: K 线取数失败，无法回测`);

  return {
    symbol,
    name: val.data?.[0]?.name ?? fin.data?.[0]?.name ?? null,
    kline: kl.data,
    valuationRows: val.data ?? [],
    fundflowRows: ff.data ?? [],
    financialsList: fin.data ?? [],
    evidence,
    asofEvidence: {
      kline: kl.evidence?.evidence_id ?? null,
      valuation: val.evidence?.evidence_id ?? null,
      fundflow: ff.evidence?.evidence_id ?? null,
      financials: fin.evidence?.evidence_id ?? null,
    },
  };
}

/** 从全量估值行里算 asof 时点的真实分位 */
function valuationPctAt(rows, asof, years) {
  const upto = rows.filter((r) => r.date <= asof);
  if (upto.length === 0) return null;
  const cur = upto[0]; // rows 按日期倒序
  const need = Math.round(years * 250);
  const win = upto.slice(0, Math.min(need, upto.length));
  const pes = win.map((r) => r.pe).filter((v) => v !== null && v > 0);
  const pbs = win.map((r) => r.pb).filter((v) => v !== null && v > 0);
  const q = (arr, v) => (v === null || arr.length < 30 ? null : Number(((arr.filter((x) => x <= v).length / arr.length) * 100).toFixed(1)));
  return {
    pe_ttm_pct: q(pes, cur.pe),
    pb_pct: q(pbs, cur.pb),
    current_pe: cur.pe,
    current_pb: cur.pb,
    window_years: years,
    as_of: cur.date,
    n: pes.length,
    board_name: null,
  };
}

/** 从资金流行里切出 asof 时点的口径 */
function fundFlowAt(rows, asof) {
  const upto = rows.filter((r) => r.date <= asof);
  if (upto.length === 0) return null;
  const last = upto.at(-1);
  const sumTail = (n) => {
    const tail = upto.slice(-n);
    return tail.some((r) => r.main_net !== null) ? tail.reduce((a, r) => a + (r.main_net ?? 0), 0) : null;
  };
  return {
    trade_date: last.date,
    main_net: last.main_net,
    small_net: last.small_net,
    medium_net: last.medium_net,
    large_net: last.large_net,
    super_net: last.super_net,
    main_net_5d: sumTail(5),
    main_net_20d: sumTail(20),
    today_date: null,
    today_main_net: null,
    history_days: upto.length,
  };
}

/**
 * 把数据包切成「asof 当日收盘后」的事实包。
 * 严格只使用 date <= asof 的数据；能回放的只有行情/估值/资金流/财报，
 * 板块、公告、龙虎榜无法回放 → 明确进 missing，不做任何猜测。
 *
 * @returns {object} Facts（CONTRACT.md §2）
 */
export function sliceAsOf(bag, asof, { years = 3 } = {}) {
  const kline = bag.kline.filter((b) => b.date <= asof);
  if (kline.length === 0) return null;

  const last = kline.at(-1);
  const prev = kline.at(-2) ?? null;
  const valuation_pct = bag.valuationRows.length ? valuationPctAt(bag.valuationRows, asof, years) : null;
  const fund_flow = bag.fundflowRows.length ? fundFlowAt(bag.fundflowRows, asof) : null;
  // 点时纪律：必须用「公告日」而不是「报告期」。三季报 9/30 的报告 10 月底才公布，
  // 用报告期做判断会在 10 月中旬就「知道」还没发布的财报。
  const financials =
    bag.financialsList.find((r) => (r.notice_date ?? r.report_date) && (r.notice_date ?? r.report_date) <= asof) ?? null;

  const evidence = bag.evidence.slice();
  const missing = [];
  if (!financials) missing.push('financials');
  if (!valuation_pct) missing.push('valuation_pct');
  if (!fund_flow) missing.push('fund_flow');
  // 以下三项在回放中不可得：诚实声明，绝不补
  missing.push('sector', 'announcements', 'billboard');

  const quote = {
    price: last.close,
    open: last.open,
    high: last.high,
    low: last.low,
    prev_close: prev ? prev.close : null,
    pct_chg: prev ? pct(last.close, prev.close) : null,
    volume: last.volume ?? null,
    amount: last.amount ?? null,
    turnover_rate: null, // 历史换手率需要当日流通股本，回放不取 → null
    pe_ttm: valuation_pct?.current_pe ?? null,
    pb: valuation_pct?.current_pb ?? null,
    amplitude: last.amplitude ?? null,
    name: bag.name,
    quote_time: last.date,
    evidence_id: bag.asofEvidence.kline,
    replayed: true,
  };

  return {
    symbol: bag.symbol,
    name: bag.name,
    market: bag.symbol.startsWith('6') ? 'sh' : bag.symbol.startsWith('0') || bag.symbol.startsWith('3') ? 'sz' : 'bj',
    trade_date: last.date,
    fetched_at: `${asof}T15:00:00+08:00`,
    is_trading: false,
    replay: { asof },
    evidence,
    missing,
    conflicts: [],
    quote,
    kline_daily: kline,
    fund_flow: fund_flow ? { ...fund_flow, evidence_id: bag.asofEvidence.fundflow } : null,
    financials: financials ? { ...financials, evidence_id: bag.asofEvidence.financials } : null,
    valuation_pct: valuation_pct ? { ...valuation_pct, evidence_id: bag.asofEvidence.valuation } : null,
    sector: null,
    billboard: [],
    announcements: [],
  };
}

/**
 * 测量 asof 之后 N 个交易日的真实结果（用于打分，不参与出卡）。
 * @returns {{short:object|null, mid:object|null, long:object|null}}
 */
export function measureOutcome(kline, asof) {
  const i = kline.findIndex((b) => b.date === asof);
  if (i < 0) return { short: null, mid: null, long: null };

  const base = kline[i].close;
  const horizon = (n) => {
    const j = i + n;
    if (j >= kline.length) return null; // 还没走到，不算
    const ret = pct(kline[j].close, base);
    let peak = base;
    let maxDd = 0;
    for (let k = i + 1; k <= j; k++) {
      const c = kline[k].close;
      if (c > peak) peak = c;
      const dd = ((c - peak) / peak) * 100;
      if (dd < maxDd) maxDd = dd;
    }
    return {
      ret_pct: ret,
      max_dd_pct: Number(maxDd.toFixed(2)),
      dir: ret === null ? null : ret > 1 ? 'up' : ret < -1 ? 'down' : 'flat',
      end_date: kline[j].date,
    };
  };

  return { short: horizon(5), mid: horizon(60), long: horizon(250) };
}
