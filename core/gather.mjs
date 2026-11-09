/**
 * 天市 · 采集编排
 *
 * 一次采集 = 把一只股票的分析所需事实全部取回，并完成：
 *   1. 双源交叉（腾讯 vs 东财）
 *   2. 缺失声明（取不到的进 missing，绝不补数）
 *   3. 证据索引（每条证据都在 facts.evidence 里）
 */

import { nowShanghai, todayShanghai, saveManifest } from './provenance.mjs';
import { fetchQuote as tencentQuote } from './sources/tencent.mjs';
import * as em from './sources/eastmoney.mjs';

const norm = (c) => String(c).replace(/^(sh|sz|bj)/i, '');

/**
 * @param {string} code 股票代码，可带 sh/sz 前缀
 * @param {{rootDir?:string, now?:Date, years?:number, asof?:string}} opts
 *   asof = 'YYYY-MM-DD' 时进入**点时回放**：只用该日期及之前的数据，绝不触碰实时接口。
 * @returns {Promise<object>} Facts（见 CONTRACT.md §2）
 */
export async function gather(code, opts = {}) {
  const { rootDir = process.cwd(), now = new Date(), years = 3, asof = null } = opts;
  const replay = typeof asof === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asof);
  const symbol = norm(code);
  const evidence = [];
  const missing = [];
  const conflicts = [];

  // ① 实时快照（回放模式下必须跳过：拿今天的价格去回放历史，就是未来函数）
  let tq = { quote: null, evidence: null };
  let eq = { data: null, evidence: null };
  let quote = null;
  if (!replay) {
    [tq, eq] = await Promise.all([
      tencentQuote(symbol, { rootDir, now }).catch((e) => ({ quote: null, evidence: null, err: e })),
      em.fetchQuote(symbol, { rootDir, now }).catch((e) => ({ data: null, evidence: null, err: e })),
    ]);
    if (tq.evidence) evidence.push(tq.evidence);
    if (eq.evidence) evidence.push(eq.evidence);
    if (!tq.quote) missing.push('quote.tencent');
    if (!eq.data) missing.push('quote.eastmoney');

    // ② 交叉验证（只有两边都拿到才比）
    conflicts.push(...crossCheckQuote(tq.quote, eq.data));

    // 主快照：优先腾讯（更快），缺则用东财
    quote = tq.quote
      ? { ...tq.quote, evidence_id: tq.evidence.evidence_id }
      : eq.data
        ? { ...eq.data, evidence_id: eq.evidence.evidence_id }
        : null;
    if (!quote) missing.push('quote');
  }

  // ③ 其余数据源并行
  const [kl, ff, fin, val, ann, bb] = await Promise.all([
    em.fetchKline(symbol, { rootDir, now, lmt: 6000, asof }).catch((e) => ({ data: null, evidence: null, err: e })),
    em.fetchFundFlow(symbol, { rootDir, now, asof }).catch((e) => ({ data: null, evidence: null, err: e })),
    em.fetchFinancials(symbol, { rootDir, now, asof }).catch((e) => ({ data: null, evidence: null, err: e })),
    em.fetchValuationPct(symbol, { rootDir, now, years, asof }).catch((e) => ({ data: null, evidence: null, err: e })),
    em.fetchAnnouncements(symbol, { rootDir, now, asof }).catch((e) => ({ data: null, evidence: null, err: e })),
    em.fetchBillboard(symbol, { rootDir, now, asof }).catch((e) => ({ data: null, evidence: null, err: e })),
  ]);
  for (const [key, res] of [
    ['kline_daily', kl],
    ['fund_flow', ff],
    ['financials', fin],
    ['valuation_pct', val],
    ['announcements', ann],
    ['billboard', bb],
  ]) {
    if (Array.isArray(res.evidence)) evidence.push(...res.evidence);
    else if (res.evidence) evidence.push(res.evidence);
    if (res.data === null) missing.push(key);
  }

  const kline_daily = attachEid(kl.data, kl.evidence);
  const fund_flow = attachEid(ff.data, ff.evidence);
  const financials = attachEid(fin.data, fin.evidence);
  const valuation_pct = attachEid(val.data, val.evidence);
  const announcements = attachEid(ann.data, ann.evidence);
  const billboard = attachEid(bb.data, bb.evidence);

  // ④ 行业板块：用行业名去板块榜里定位
  let sector = null;
  const industry = val.data?.board_name ?? eq.data?.industry ?? null;
  if (industry) {
    const sec = await em.fetchSector(industry, { rootDir, now, code: symbol }).catch(() => ({ data: null, evidence: [] }));
    const secEv = Array.isArray(sec.evidence) ? sec.evidence : sec.evidence ? [sec.evidence] : [];
    evidence.push(...secEv);
    sector = sec.data;
    if (!sector) missing.push('sector');
    else if (!sector.matched) missing.push(`sector.match(${industry})`);
  } else {
    missing.push('sector');
  }

  // ⑤ 交易日期与交易状态
  const lastBar = kline_daily?.at(-1) ?? null;
  const trade_date = lastBar?.date ?? null;
  const today = todayShanghai(now);
  const is_trading = trade_date === today ? true : false;

  // ⑥ 一致性原始冲突：快照价 vs 最后一根K线收盘（非交易日应相等）
  if (quote && lastBar && trade_date !== today) {
    const delta = Math.abs(quote.price - lastBar.close) / lastBar.close;
    if (delta > 0.001) {
      conflicts.push({
        field: 'quote.price vs kline.close',
        values: [
          { source: 'tencent', value: quote.price },
          { source: 'kline', value: lastBar.close },
        ],
        delta_pct: Number((delta * 100).toFixed(3)),
        severity: 'warn',
      });
    }
  }

  // ⑦ 落 manifest（离线审计依据）
  saveManifest({ symbol, trade_date, fetched_at: nowShanghai(now), evidence }, rootDir, now);

  return {
    symbol,
    name: quote?.name ?? eq.data?.name ?? null,
    market: symbol.startsWith('6') ? 'sh' : symbol.startsWith('0') || symbol.startsWith('3') ? 'sz' : 'bj',
    trade_date,
    fetched_at: nowShanghai(now),
    is_trading,
    evidence,
    missing,
    conflicts,
    quote,
    kline_daily: kline_daily ?? [],
    fund_flow,
    financials,
    valuation_pct,
    sector,
    billboard,
    announcements: announcements ?? [],
  };
}

function attachEid(data, ev) {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data; // 数组元素不挂单条证据，由 facts.evidence 统一索引
  // 数据自带 evidence_id（如资金流有 daily/intraday 两条证据）时不得覆盖
  if (Array.isArray(ev)) return { ...data, evidence_id: data.evidence_id ?? ev[0]?.evidence_id ?? null };
  return { ...data, evidence_id: data.evidence_id ?? ev?.evidence_id ?? null };
}

/** 双源价格/涨跌幅交叉 */
function crossCheckQuote(a, b) {
  const out = [];
  if (!a || !b) return out;
  const cmp = (field, va, vb, tolerance) => {
    if (va === null || va === undefined || vb === null || vb === undefined) return;
    const d = Math.abs(va - vb);
    if (d > tolerance) {
      const base = Math.abs(va) || 1;
      out.push({
        field,
        values: [
          { source: 'tencent', value: va },
          { source: 'eastmoney', value: vb },
        ],
        delta_pct: Number(((d / base) * 100).toFixed(3)),
        severity: d / base > 0.005 ? 'fail' : 'warn',
      });
    }
  };
  cmp('quote.price', a.price, b.price, 0.011);
  cmp('quote.pct_chg', a.pct_chg, b.pct_chg, 0.05);
  cmp('quote.high', a.high, b.high, 0.011);
  cmp('quote.low', a.low, b.low, 0.011);
  return out;
}
