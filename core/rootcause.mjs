/**
 * 根因链路：把个股涨跌拆成「大盘 → 板块 → 海外映射 → 个股自身」，每一环都用历史数据实测
 *
 * 方法（全部可复核）：
 *   1. 日收益率：收盘价环比；单日绝对值 >40% 视为拆股 / 除权等公司行为，剔除不用
 *      （实测发现东财部分美股 ETF 存在未复权跳点，如 SOXX 单日 450 → 131）
 *   2. 大盘贡献  = β_大盘 × 大盘当日涨跌，β 用近 120 个共同交易日回归
 *   3. 板块贡献  = β_板块 × 板块相对大盘的超额，板块超额 = 板块涨跌 − β(板块,大盘) × 大盘涨跌
 *      └ 其中可由海外隔夜解释的部分 = β_板块 × γ × 海外篮子隔夜涨跌，γ 为板块超额对海外的回归系数
 *   4. 个股自身  = 个股涨跌 − 大盘贡献 − 板块贡献（消息、资金、题材等个股因素）
 *   5. 海外映射用「A 股交易日 D 对应美股 D 之前最近一个交易日」对齐（美股收盘在 A 股开盘之前）
 *   6. 每条联动都给出相关系数与样本数；|r| < 2/√n 视为统计上不显著，只标「本体关联、数据未证实」
 *
 * 这是**归因**（解释已经发生的涨跌由哪些部分构成），不是预测。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

/** 取任意 secid 的日收盘序列 */
export async function fetchCloses(secid, lmt = 160, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
      `&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=1&end=20500101&lmt=${lmt}`,
      { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } },
    );
    if (!r.ok) return [];
    const j = await r.json();
    return (j?.data?.klines ?? []).map((l) => {
      const [date, close] = l.split(',');
      return { date, close: Number(close) };
    }).filter((b) => b.date && isNum(b.close) && b.close > 0);
  } catch { return []; } finally { clearTimeout(timer); }
}

/** 收盘价 → 日收益（%），剔除公司行为跳点 */
export function toReturns(bars) {
  const out = new Map();
  const dropped = [];
  const list = (bars ?? []).filter((b) => isNum(b.close) && b.close > 0);
  for (let i = 1; i < list.length; i++) {
    const r = ((list[i].close - list[i - 1].close) / list[i - 1].close) * 100;
    if (Math.abs(r) > 40) { dropped.push(list[i].date); continue; }
    out.set(list[i].date, r);
  }
  return { rets: out, dropped };
}

/** 海外序列按「A 股日 D ← 美股 D 之前最近一个交易日」对齐 */
export function alignLagged(aDates, overseasRets) {
  const usDates = [...overseasRets.keys()].sort();
  const out = new Map();
  let j = -1;
  for (const d of [...aDates].sort()) {
    while (j + 1 < usDates.length && usDates[j + 1] < d) j++;
    if (j >= 0) out.set(d, { date: usDates[j], ret: overseasRets.get(usDates[j]) });
  }
  return out;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function covVar(x, y) {
  const mx = mean(x), my = mean(y);
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < x.length; i++) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  return { cov: c / x.length, varX: vx / x.length, varY: vy / x.length };
}
/** y 对 x 的回归斜率与相关系数 */
export function regress(y, x) {
  if (x.length < 20) return { beta: null, r: null, n: x.length };
  const { cov, varX, varY } = covVar(x, y);
  if (!(varX > 0) || !(varY > 0)) return { beta: null, r: null, n: x.length };
  return { beta: cov / varX, r: cov / Math.sqrt(varX * varY), n: x.length };
}
const significant = (r, n) => isNum(r) && n > 0 && Math.abs(r) >= 2 / Math.sqrt(n);
const r2 = (v) => (isNum(v) ? Number(v.toFixed(2)) : null);

/**
 * @param {object} p
 *  stockBars / marketBars / sectorBars：[{date, close}]
 *  drivers：[{key, name, role, bars}]  海外映射标的
 *  window：回归窗口（交易日）
 */
export function analyzeRootCause(p) {
  const { stockBars, marketBars, sectorBars, drivers = [], window = 120, marketName = '大盘', sectorName = '板块' } = p;
  const S = toReturns(stockBars);
  const M = toReturns(marketBars);
  const B = toReturns(sectorBars);
  const notes = [];
  if (S.dropped.length) notes.push(`个股有 ${S.dropped.length} 个交易日涨跌超 40%（除权等），已剔除`);

  // 共同交易日（个股 ∩ 大盘），取最近 window 天
  const dates = [...S.rets.keys()].filter((d) => M.rets.has(d)).sort().slice(-window);
  if (dates.length < 30) {
    return { ok: false, reason: `共同交易日不足（${dates.length} 天），无法归因`, notes };
  }
  const s = dates.map((d) => S.rets.get(d));
  const m = dates.map((d) => M.rets.get(d));
  const regM = regress(s, m);
  const betaM = regM.beta ?? 1;

  // 板块超额（相对大盘）
  const hasSector = B.rets.size > 30;
  const sDates = hasSector ? dates.filter((d) => B.rets.has(d)) : [];
  let betaS = null, regS = null, sectorBetaM = null;
  const sectorEx = new Map();
  if (sDates.length >= 30) {
    const bm = regress(sDates.map((d) => B.rets.get(d)), sDates.map((d) => M.rets.get(d)));
    sectorBetaM = bm.beta ?? 1;
    for (const d of sDates) sectorEx.set(d, B.rets.get(d) - sectorBetaM * M.rets.get(d));
    const resid = sDates.map((d) => S.rets.get(d) - betaM * M.rets.get(d));
    regS = regress(resid, sDates.map((d) => sectorEx.get(d)));
    betaS = regS.beta;
  } else if (hasSector) {
    notes.push('板块与个股共同交易日不足，板块环节未计算');
  } else {
    notes.push('未取到所属板块走势，板块环节未计算');
  }

  // 海外映射：逐个实测联动，显著的组成篮子
  const driverStats = [];
  const lagged = new Map(); // key → Map(date → {date, ret})
  for (const dv of drivers) {
    const R = toReturns(dv.bars);
    if (R.dropped.length) notes.push(`${dv.name} 有 ${R.dropped.length} 个跳点（疑似拆股未复权），已剔除`);
    if (R.rets.size < 30) { driverStats.push({ ...stripBars(dv), ok: false, reason: '海外数据不足' }); continue; }
    const al = alignLagged(dates, R.rets);
    lagged.set(dv.key, al);
    const dd = dates.filter((d) => al.has(d));
    const rs = regress(dd.map((d) => S.rets.get(d)), dd.map((d) => al.get(d).ret));
    // 对板块超额的联动（海外 → 板块这一环）
    const dds = dd.filter((d) => sectorEx.has(d));
    const rb = dds.length >= 30 ? regress(dds.map((d) => sectorEx.get(d)), dds.map((d) => al.get(d).ret)) : null;
    const last = al.get(dates[dates.length - 1]);
    driverStats.push({
      ...stripBars(dv), ok: true,
      corr_stock: r2(rs.r), corr_sector: rb ? r2(rb.r) : null, n: rs.n,
      significant: significant(rs.r, rs.n) || (rb ? significant(rb.r, rb.n) : false),
      last_date: last?.date ?? null, last_ret: last ? r2(last.ret) : null,
    });
  }
  const basketKeys = driverStats.filter((x) => x.ok && x.significant).map((x) => x.key);
  const basketRet = (d) => {
    const vals = basketKeys.map((k) => lagged.get(k)?.get(d)?.ret).filter(isNum);
    return vals.length ? mean(vals) : null;
  };
  let gamma = null, regO = null;
  if (basketKeys.length && sectorEx.size) {
    const od = [...sectorEx.keys()].filter((d) => isNum(basketRet(d)));
    if (od.length >= 30) { regO = regress(od.map((d) => sectorEx.get(d)), od.map((d) => basketRet(d))); gamma = regO.beta; }
  }

  /* 单日 / 区间分解 */
  function decompose(days) {
    let total = 0, mk = 0, sec = 0, ovs = 0, n = 0;
    for (const d of days) {
      const sv = S.rets.get(d), mv = M.rets.get(d);
      if (!isNum(sv) || !isNum(mv)) continue;
      total += sv; mk += betaM * mv;
      if (isNum(betaS) && sectorEx.has(d)) {
        sec += betaS * sectorEx.get(d);
        const b = basketRet(d);
        if (isNum(gamma) && isNum(b)) ovs += betaS * gamma * b;
      }
      n++;
    }
    const own = total - mk - sec;
    return { days: n, total: r2(total), market: r2(mk), sector: r2(sec), overseas_in_sector: r2(ovs), own: r2(own) };
  }
  const today = decompose(dates.slice(-1));
  const d5 = decompose(dates.slice(-5));
  const d20 = decompose(dates.slice(-20));

  /* 主因判定 */
  function mainCause(x) {
    if (!isNum(x.total) || Math.abs(x.total) < 0.5) return { key: 'flat', text: '涨跌幅很小，没有明显驱动' };
    const parts = [
      { key: 'market', name: marketName + '带动', v: x.market },
      { key: 'sector', name: sectorName + '带动', v: x.sector },
      { key: 'own', name: '个股自身因素', v: x.own },
    ].filter((p2) => isNum(p2.v));
    const top = parts.sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
    const share = Math.abs(top.v) / (Math.abs(x.market ?? 0) + Math.abs(x.sector ?? 0) + Math.abs(x.own ?? 0) || 1);
    let text = `${top.name}为主（约占 ${Math.round(share * 100)}%）`;
    if (top.key === 'sector' && isNum(x.overseas_in_sector) && Math.abs(x.overseas_in_sector) >= Math.abs(top.v) * 0.4) {
      text += '，其中相当一部分可由海外隔夜走势解释';
    }
    if (top.key === 'own') text += '：大盘和板块解释不了，需要查公告、资金、龙虎榜';
    return { key: top.key, text, share: r2(share) };
  }

  // 模型解释力（R²）：大盘 + 板块 两因子
  let fitR2 = null;
  if (isNum(betaS) && sDates.length >= 30) {
    const y = sDates.map((d) => S.rets.get(d));
    const yhat = sDates.map((d) => betaM * M.rets.get(d) + betaS * sectorEx.get(d));
    const my = mean(y);
    const ssr = y.reduce((a, v, i) => a + (v - yhat[i]) ** 2, 0);
    const sst = y.reduce((a, v) => a + (v - my) ** 2, 0);
    fitR2 = sst > 0 ? r2(1 - ssr / sst) : null;
  } else if (isNum(regM.r)) {
    fitR2 = r2(regM.r ** 2);
  }

  return {
    ok: true,
    window: dates.length,
    last_date: dates[dates.length - 1],
    links: {
      market: { name: marketName, beta: r2(betaM), corr: r2(regM.r), n: regM.n, significant: significant(regM.r, regM.n) },
      sector: regS ? { name: sectorName, beta: r2(betaS), corr: r2(regS.r), n: regS.n, significant: significant(regS.r, regS.n), sector_beta_to_market: r2(sectorBetaM) } : null,
      overseas: { basket: basketKeys, gamma: r2(gamma), corr_sector: regO ? r2(regO.r) : null, n: regO?.n ?? 0, drivers: driverStats },
    },
    decomposition: { today, d5, d20 },
    main_cause: { today: mainCause(today), d5: mainCause(d5), d20: mainCause(d20) },
    fit_r2: fitR2,
    notes,
    method: '归因不是预测：β 与相关系数来自近 ' + dates.length + ' 个交易日的实测；海外映射按美股前一交易日对齐',
  };
}

function stripBars(dv) {
  const { bars, ...rest } = dv;
  return rest;
}

/**
 * 大盘基准统一用沪深 300：科创 50 / 创业板指本身行业集中（科创 50 大半是半导体），
 * 用它们当「大盘」会把板块效应吸收进大盘，导致板块 β 失真。
 */
export function marketIndexFor() {
  return { secid: '1.000300', name: '沪深300' };
}

/* ══════════ 组装：从事实包出发跑完整链路 ══════════ */

import { matchOntology, OVERSEAS } from './ontology.mjs';

const seriesCache = new Map(); // secid → {at, bars}
const SERIES_TTL = 30 * 60 * 1000;
async function cachedCloses(secid) {
  const hit = seriesCache.get(secid);
  if (hit && Date.now() - hit.at < SERIES_TTL) return hit.bars;
  const bars = await fetchCloses(secid);
  if (bars.length) seriesCache.set(secid, { at: Date.now(), bars });
  return bars;
}

async function fetchConcepts(symbol) {
  const suc = /^(6|9)/.test(symbol) ? `${symbol}.SH` : /^(83|87|88|92|43|82)/.test(symbol) ? `${symbol}.BJ` : `${symbol}.SZ`;
  try {
    const r = await fetch(
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_CORETHEME_BOARDTYPE&columns=BOARD_NAME` +
      `&filter=(SECUCODE%3D%22${suc}%22)&pageNumber=1&pageSize=60&source=HSF10&client=PC`,
      { headers: { 'User-Agent': UA } },
    );
    const j = await r.json();
    return (j?.result?.data ?? []).map((x) => String(x.BOARD_NAME ?? '')).filter(Boolean);
  } catch { return []; }
}

/**
 * @param {string} symbol 6 位代码
 * @param {object} facts gather 输出（用其中的 industry / sector / kline_daily）
 */
export async function buildRootCause(symbol, facts) {
  const industry = facts?.quote?.industry ?? facts?.industry ?? facts?.sector?.industry_query ?? '';
  const sector = facts?.sector?.matched ? facts.sector : null;
  const concepts = await fetchConcepts(symbol);
  const ont = matchOntology(industry, concepts);
  const keys = [...new Set(ont.nodes.flatMap((n) => n.drivers))].slice(0, 4);
  const mi = marketIndexFor(symbol);
  const mk = /^(6|9)/.test(symbol) ? '1' : '0';
  const [stockBars, marketBars, sectorBars, ...dbars] = await Promise.all([
    fetchCloses(`${mk}.${symbol}`),
    cachedCloses(mi.secid),
    sector?.code ? cachedCloses(`90.${sector.code}`) : Promise.resolve([]),
    ...keys.map((k) => cachedCloses(OVERSEAS[k].secid)),
  ]);
  const rc = analyzeRootCause({
    stockBars, marketBars, sectorBars,
    marketName: mi.name, sectorName: sector?.name ?? '所属板块',
    drivers: keys.map((k, i) => ({ key: k, ...OVERSEAS[k], bars: dbars[i] })),
  });
  return {
    ...rc,
    symbol,
    industry,
    sector: sector ? { code: sector.code, name: sector.name, pct_chg: sector.pct_chg ?? null } : null,
    ontology: {
      nodes: ont.nodes.map((n) => ({ key: n.key, name: n.name, chain: n.chain, factors: n.factors, via: n.via, drivers: n.drivers.map((k) => OVERSEAS[k]?.name ?? k) })),
      domestic: ont.domestic,
      concepts: concepts.slice(0, 12),
    },
  };
}

/** 给 AI 的一段文字摘要（只陈述实测结果，不加推断） */
export function summarizeRootCause(rc) {
  if (!rc) return '';
  const L = [];
  const on = rc.ontology ?? {};
  if (on.nodes?.length) {
    L.push(`【产业链定位】${on.nodes.map((n) => `${n.name}（${n.chain}）`).join('；')}`);
    const fs = [...new Set(on.nodes.flatMap((n) => n.factors))].slice(0, 6);
    if (fs.length) L.push(`【需检查的驱动因素】${fs.join('、')}（本系统未接入这些因素的实时数据，只能作为检查清单）`);
  } else if (on.domestic) {
    L.push(`【产业链定位】无明显海外映射，${on.domestic.reason}`);
  }
  if (!rc.ok || rc.engine_ok === false || !rc.links) { L.push(`【根因链路】${rc.reason || '数据不足，不能归因'}`); return L.join('\n'); }
  const lk = rc.links;
  L.push(`【链路实测（近 ${rc.window} 日）】对${lk.market.name} β=${lk.market.beta}（r=${lk.market.corr}）` +
    (lk.sector ? `；对${lk.sector.name}超额 β=${lk.sector.beta}（r=${lk.sector.corr}，${lk.sector.significant ? '显著' : '不显著'}）` : '；板块环节缺失') +
    `；两因子解释力 R²=${rc.fit_r2}`);
  const ds = (lk.overseas.drivers ?? []).filter((d) => d.ok);
  if (ds.length) {
    L.push(`【海外映射】` + ds.map((d) => `${d.name} 隔夜 ${d.last_ret}%（与个股 r=${d.corr_stock}，${d.significant ? '联动显著' : '本体关联、数据未证实'}）`).join('；'));
  }
  for (const [k, label] of [['today', '今日'], ['d5', '近5日'], ['d20', '近20日']]) {
    const x = rc.decomposition[k];
    L.push(`【${label}归因】合计 ${x.total}% = 大盘 ${x.market} + 板块 ${x.sector}（其中海外可解释 ${x.overseas_in_sector}） + 个股自身 ${x.own} → ${rc.main_cause[k].text}`);
  }
  return L.join('\n');
}
