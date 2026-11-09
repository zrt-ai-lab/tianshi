/**
 * 大盘体检 · 市场环境与「国家队」行为痕迹推断
 *
 * 重要边界（必须写在输出里）：
 *   1. 国家队没有官方披露，本模块只做**行为痕迹推断**，输出是「疑似/无明显迹象」，不是事实认定。
 *   2. 北向资金自 2024 年 8 月起取消盘中实时披露，本模块不使用任何「实时北向」数据。
 *   3. 所有推断都给出触发证据（哪个指标、多少倍、什么阈值），可复核。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

async function getJson(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const ymd = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 指数清单：名称 + secid */
const INDICES = [
  ['上证指数', '1.000001'],
  ['深证成指', '0.399001'],
  ['创业板指', '0.399006'],
  ['科创50', '1.000688'],
  ['沪深300', '1.000300'],
  ['中证500', '1.000905'],
  ['中证1000', '1.000852'],
];

/**
 * 宽基 ETF：护盘常用工具
 * 口径参考（重要）：汇金持仓名单自 2026-05-01 新规后不再披露，任何「国家队持仓」都无法验证；
 * 因此本模块只做量价痕迹推断，不做持仓认定。
 */
const ETFS = [
  ['沪深300ETF华泰柏瑞', '1.510300', 'sh510300'],
  ['沪深300ETF易方达', '1.510310', 'sh510310'],
  ['上证50ETF华夏', '1.510050', 'sh510050'],
  ['中证500ETF南方', '0.159922', 'sz159922'],
  ['创业板ETF易方达', '0.159915', 'sz159915'],
  ['科创50ETF华夏', '1.588000', 'sh588000'],
];

/* ── 日内完成比例曲线：用最近几个完整交易日算「到某时刻平均已走完全天成交额的比例」 ── */
async function intradayCurve(refSecid = '1.510300', days = 5) {
  try {
    const j = await getJson(
      `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${refSecid}` +
      `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=${days}`,
    );
    const pts = j?.data?.trends ?? [];
    if (!pts.length) return null;
    const today = ymd();
    const byDay = new Map();
    for (const line of pts) {
      const [dt, , , , , , amount] = line.split(',');
      const [d, tm] = dt.split(' ');
      const amt = Number(amount);
      if (!Number.isFinite(amt)) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push([tm, amt]);
    }
    // 只使用完整交易日（排除当天未收盘）
    const complete = [...byDay.entries()].filter(([d, arr]) => d !== today && arr.length > 200).map(([, a]) => a);
    if (!complete.length) return null;
    const avg = new Map();
    for (const arr of complete) {
      const total = arr.reduce((x, y) => x + y[1], 0);
      if (!total) continue;
      let cum = 0;
      for (const [tm, amt] of arr) {
        cum += amt;
        if (!avg.has(tm)) avg.set(tm, []);
        avg.get(tm).push(cum / total);
      }
    }
    const out = new Map();
    for (const [tm, arr] of avg) out.set(tm, arr.reduce((a, b) => a + b, 0) / arr.length);
    return out;
  } catch {
    return null;
  }
}

/** 当前时刻在曲线上的完成比例（找不到就取最近的前一个时点） */
function completionAt(curve, now = new Date()) {
  if (!curve) return null;
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(now.getHours())}:${p(now.getMinutes())}`;
  let best = null;
  for (const [tm, v] of curve) if (tm <= hm && (best === null || tm > best[0])) best = [tm, v];
  return best ? best[1] : null;
}

/** 腾讯 ETF 行情（含外盘/内盘） */
async function tencentEtfQuotes(codes) {
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${codes.join(',')}`, {
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = new TextDecoder('gbk').decode(buf);
    const out = new Map();
    for (const line of text.split(';')) {
      const m = line.match(/v_([a-z]{2}\d{6})="([^"]*)"/);
      if (!m) continue;
      const f = m[2].split('~');
      out.set(m[1], {
        name: f[1],
        price: Number(f[3]),
        volumeLots: Number(f[6]),
        outer: Number(f[7]),
        inner: Number(f[8]),
        amount: Number(f[37]) * 1e4, // 万元 → 元
        pct: Number(f[32]),
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

/** 护盘常见板块关键词 */
const DEFENSE_KEYWORDS = ['银行', '保险', '证券', '央企', '中字头', '石油', '煤炭', '电力', '公用事业'];

export async function fetchMarket() {
  const fetched_at = new Date().toISOString();

  const [idxRes, etfRes, ztRes, dtRes, zbRes, sectorRes, shKline] = await Promise.all([
    getJson(`https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${INDICES.map((x) => x[1]).join(',')}&fields=f2,f3,f4,f6,f12,f14,f104,f105`).catch(() => null),
    getJson(`https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${ETFS.map((x) => x[1]).join(',')}&fields=f2,f3,f6,f12,f14`).catch(() => null),
    getJson(`https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=lbc%3Adesc&date=${ymd()}`).catch(() => null),
    getJson(`https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fund%3Aasc&date=${ymd()}`).catch(() => null),
    getJson(`https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=${ymd()}`).catch(() => null),
    getJson('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f3').catch(() => null),
    getJson('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=25').catch(() => null),
  ]);

  // 指数
  const indices = (idxRes?.data?.diff ?? []).map((x) => ({
    name: x.f14,
    secid: String(x.f12 ?? ''),
    price: num(x.f2) === null ? null : num(x.f2) / 100,
    pct: num(x.f3) === null ? null : num(x.f3) / 100,
    amount: num(x.f6),
    up: num(x.f104),
    down: num(x.f105),
  }));

  // 涨跌家数（沪深两市合并，避免重复：只取上证指数 + 深证成指）
  const sh = indices.find((i) => i.name === '上证指数');
  const sz = indices.find((i) => i.name === '深证成指');
  const upCount = (sh?.up ?? 0) + (sz?.up ?? 0);
  const downCount = (sh?.down ?? 0) + (sz?.down ?? 0);
  const breadth = {
    up: upCount || null,
    down: downCount || null,
    total: upCount + downCount || null,
    up_ratio: upCount + downCount ? Number(((upCount / (upCount + downCount)) * 100).toFixed(1)) : null,
  };

  // 涨跌停
  const ztPool = ztRes?.data?.pool ?? [];
  const lbcs = ztPool.map((x) => Number(x.lbc) || 0);
  const limit = {
    up: num(ztRes?.data?.tc),
    down: num(dtRes?.data?.tc),
    broken: num(zbRes?.data?.tc),
    broken_rate: null,
    max_board: lbcs.length ? Math.max(...lbcs) : null,
    lianban_count: lbcs.filter((x) => x >= 2).length || null,
    first_board_count: lbcs.filter((x) => x === 1).length || null,
  };
  if (limit.broken !== null && limit.up !== null && limit.up + limit.broken > 0) {
    limit.broken_rate = Number(((limit.broken / (limit.up + limit.broken)) * 100).toFixed(1));
  }

  // 两市成交额与环比
  const shBars = shKline?.data?.klines ?? [];
  const amounts = shBars.map((l) => Number(l.split(',')[6])).filter((v) => Number.isFinite(v));
  const shAmount = amounts.at(-1) ?? null;
  const shPrev = amounts.at(-2) ?? null;
  const amountChange = shAmount !== null && shPrev ? Number((((shAmount - shPrev) / shPrev) * 100).toFixed(1)) : null;
  const totalAmount = indices.reduce((a, i) => a + (i.amount ?? 0), 0) || null;

  // ETF：成交额 + 20 日均额 + 同时点对齐倍数 + 主动净买入
  const curve = await intradayCurve();
  const tq = await tencentEtfQuotes(ETFS.map((x) => x[2]));
  const etfs = [];
  for (const [name, secid, tsym] of ETFS) {
    const q = tq.get(tsym) ?? null;
    let avg20 = null;
    try {
      const k = await getJson(
        `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=21`,
      );
      const arr = (k?.data?.klines ?? []).map((l) => Number(l.split(',')[6])).filter((v) => Number.isFinite(v));
      if (arr.length >= 10) avg20 = arr.slice(0, -1).reduce((a, b) => a + b, 0) / (arr.length - 1);
    } catch {
      avg20 = null;
    }
    const amount = q?.amount ?? null;
    const done = completionAt(curve);
    const activeNet = q && Number.isFinite(q.outer) && Number.isFinite(q.inner) && q.outer + q.inner > 0
      ? ((q.outer - q.inner) / (q.outer + q.inner)) * (amount ?? 0)
      : null;
    etfs.push({
      name,
      secid,
      amount,
      pct: q?.pct ?? null,
      avg20,
      // 原始倍数（半天÷全天均额，盘中不可直接下结论，仅作参考）
      raw_ratio: amount !== null && avg20 ? Number((amount / avg20).toFixed(2)) : null,
      // 同时点对齐倍数（可比值：分子分母都代表「到此刻为止」）
      ratio: amount !== null && avg20 && done ? Number((amount / (avg20 * done)).toFixed(2)) : null,
      progress: done === null ? null : Number((done * 100).toFixed(1)),
      outer: q?.outer ?? null,
      inner: q?.inner ?? null,
      active_net: activeNet,
    });
  }

  // 行业板块
  const sectorDiff = sectorRes?.data?.diff ?? [];
  const sectors = sectorDiff.map((x) => ({ name: x.f14, pct: num(x.f3) })).filter((x) => x.name);
  const topSectors = sectors.slice(0, 8);
  const bottomSectors = sectors.slice(-5).reverse();

  return {
    ok: true,
    fetched_at,
    indices,
    breadth,
    limit,
    amount: {
      total: totalAmount,
      sh: shAmount,
      sh_prev: shPrev,
      sh_change_pct: amountChange,
    },
    etfs,
    sectors: { top: topSectors, bottom: bottomSectors, total: sectors.length },
    sources: [
      'push2.eastmoney.com/api/qt/ulist.np/get',
      'push2ex.eastmoney.com/getTopicZTPool',
      'push2ex.eastmoney.com/getTopicDTPool',
      'push2ex.eastmoney.com/getTopicZBPool',
      'push2.eastmoney.com/api/qt/clist/get',
      'push2his.eastmoney.com/api/qt/stock/kline/get',
    ],
  };
}

/**
 * 大盘温度 + 国家队痕迹推断
 * @returns {{temperature:number|null, regime:string, headline:string, signals:Array, caveats:string[]}}
 */
export function interpretMarket(m) {
  const caveats = [];
  const signals = [];
  const idx = m.indices ?? [];
  const byName = Object.fromEntries(idx.map((i) => [i.name, i]));

  /* ── 大盘温度（0-100）：宽度 40 + 涨跌停结构 25 + 指数 20 + 量能 15 ── */
  let score = 0;
  let weight = 0;
  if (m.breadth?.up_ratio != null) {
    score += m.breadth.up_ratio * 0.4;
    weight += 40;
  } else caveats.push('涨跌家数缺失，宽度未计分');

  if (m.limit?.up != null && m.limit?.down != null) {
    const net = m.limit.up - m.limit.down;
    const scaled = Math.max(0, Math.min(100, 50 + net * 1.2));
    score += scaled * 0.25;
    weight += 25;
    if (m.limit.broken_rate != null && m.limit.broken_rate > 40) caveats.push(`炸板率 ${m.limit.broken_rate}% 偏高，承接力弱`);
  } else caveats.push('涨跌停池缺失，情绪结构未计分');

  const avgPct = idx.length ? idx.reduce((a, i) => a + (i.pct ?? 0), 0) / idx.length : null;
  if (avgPct !== null) {
    score += Math.max(0, Math.min(100, 50 + avgPct * 12)) * 0.2;
    weight += 20;
  }

  if (m.amount?.sh_change_pct != null) {
    score += Math.max(0, Math.min(100, 50 + m.amount.sh_change_pct * 1.5)) * 0.15;
    weight += 15;
  } else caveats.push('成交额环比缺失，量能未计分');

  const temperature = weight > 0 ? Math.round((score / weight) * 100) : null;

  let regime = 'unknown';
  let headline = '数据不足';
  if (temperature !== null) {
    if (temperature >= 65) { regime = 'attack'; headline = `偏强：大盘温度 ${temperature}，可正常择股`; }
    else if (temperature >= 45) { regime = 'neutral'; headline = `震荡：大盘温度 ${temperature}，仓位宜控`; }
    else { regime = 'defense'; headline = `偏弱：大盘温度 ${temperature}，优先防守`; }
  }

  /* ── 国家队痕迹：4 个可观测行为 ── */
  const hs300 = byName['沪深300'];
  const zz1000 = byName['中证1000'];

  // ① 宽基 ETF 放量（沪深300ETF 成交额 / 20日均值）
  const hs300etf = (m.etfs ?? []).find((e) => String(e.name).indexOf('沪深300ETF华泰柏瑞') === 0) ?? (m.etfs ?? [])[0];
  if (hs300etf?.ratio != null) {
    const r = hs300etf.ratio;
    const hit = r >= 1.8;
    signals.push({
      key: 'etf_volume',
      name: '宽基ETF放量',
      hit,
      strength: hit ? (r >= 3 ? 'strong' : 'medium') : 'none',
      detail: `${hs300etf.name} 成交额 ${(hs300etf.amount / 1e8).toFixed(1)} 亿，同时点对齐后是 20 日均额的 ${r} 倍` +
        (hs300etf.progress != null ? `（此刻历史平均已完成 ${hs300etf.progress}%）` : '') + (hit ? '，放量明显' : ''),
      plain: hit
        ? `ETF 今天放量到平时的 ${r} 倍——有大资金借道 ETF 进场`
        : `ETF 成交额只有平时的 ${r} 倍，没放量——不像有大资金借道进场`,
    });
  } else signals.push({ key: 'etf_volume', name: '宽基ETF放量', hit: false, strength: 'none', detail: 'ETF 数据缺失' });

  // 主动净买入（外盘−内盘 逐笔方向推算，不是资金净流入）
  if (hs300etf?.active_net != null) {
    const net = hs300etf.active_net;
    const hit = Math.abs(net) >= 1e8;
    signals.push({
      key: 'active_net',
      name: 'ETF主动净买入',
      hit,
      strength: Math.abs(net) >= 3e8 ? 'strong' : hit ? 'medium' : 'none',
      detail: `${hs300etf.name} 主动净买入估算 ${(net / 1e8).toFixed(2)} 亿` +
        `（外盘 ${hs300etf.outer} / 内盘 ${hs300etf.inner}，逐笔方向推算，非资金净流入）`,
      plain: net > 0
        ? `盘面上主动买的人比主动卖的多，净流入约 ${(net / 1e8).toFixed(2)} 亿`
        : `盘面上主动卖的人更多，净流出约 ${(Math.abs(net) / 1e8).toFixed(2)} 亿`,
    });
  }

  // ② 大小盘背离（资金护大盘不护小盘）
  if (hs300?.pct != null && zz1000?.pct != null) {
    const gap = hs300.pct - zz1000.pct;
    const hit = gap >= 0.8;
    signals.push({
      key: 'large_small',
      name: '大小盘背离',
      hit,
      strength: hit ? (gap >= 1.5 ? 'strong' : 'medium') : 'none',
      detail: `沪深300 ${hs300.pct.toFixed(2)}% vs 中证1000 ${zz1000.pct.toFixed(2)}%，差 ${gap.toFixed(2)}pp${hit ? '（大盘股明显抗跌/领涨）' : ''}`,
      plain: hit
        ? `大盘股比小盘股强 ${gap.toFixed(2)} 个百分点——护盘通常是拉权重、不管小票`
        : `大盘股和小盘股表现差不多（差 ${gap.toFixed(2)} 个百分点），看不出护盘`,
    });
  }

  // ③ 护盘板块走强（银行/保险/券商/中字头等）
  const tops = (m.sectors?.top ?? []).map((s) => s.name);
  const defenseTop = tops.filter((n) => DEFENSE_KEYWORDS.some((k) => String(n).includes(k)));
  signals.push({
    key: 'defense_sector',
    name: '护盘板块走强',
    hit: defenseTop.length > 0,
    strength: defenseTop.length >= 2 ? 'strong' : defenseTop.length === 1 ? 'medium' : 'none',
    detail: defenseTop.length
      ? `涨幅榜前列出现护盘板块：${defenseTop.join('、')}`
      : '涨幅榜前列没有银行/保险/券商/中字头',
    plain: defenseTop.length
      ? `涨幅榜里有${defenseTop.join('、')}——这类板块常被用来托指数`
      : '涨幅榜里没有银行、保险、券商这类护盘常客',
  });

  // ④ 指数普涨 vs 个股普跌（指数强、个股弱 → 权重护盘特征）
  if (avgPct != null && m.breadth?.up_ratio != null) {
    const diverge = avgPct > 0.2 && m.breadth.up_ratio < 45;
    signals.push({
      key: 'index_vs_breadth',
      name: '指数强个股弱',
      hit: diverge,
      strength: diverge ? 'medium' : 'none',
      detail: `指数平均 ${avgPct >= 0 ? '+' : ''}${avgPct.toFixed(2)}%，但上涨家数仅 ${m.breadth.up_ratio}%${diverge ? '（典型的权重护盘形态）' : ''}`,
      plain: diverge
        ? '指数红了，但一大半个股在跌——这是拉权重护指数的典型样子'
        : '指数和个股的强弱基本一致，没有背离',
    });
  }

  const hitCount = signals.filter((s) => s.hit).length;
  const strongCount = signals.filter((s) => s.strength === 'strong').length;
  let footprint = 'none';
  let footprintText = '没有看到护盘迹象';
  let summary = '今天盘面上看不到大资金托市的动作：ETF 没放量、权重也没明显强于小票。';
  if (strongCount >= 2 || hitCount >= 3) {
    footprint = 'likely';
    footprintText = '大概率有护盘资金在买';
    summary = '几条痕迹同时出现，今天大概率有大资金在托市。注意：这只是从盘面推断，没有官方确认。';
  } else if (hitCount >= 1) {
    footprint = 'weak';
    footprintText = '有一点迹象，但证据不足';
    summary = '看到一两条类似护盘的动作，但其他指标不支持，还不能下结论。';
  }

  caveats.push('国家队无官方披露，以上为公开数据的行为痕迹推断，不是事实认定');
  caveats.push('汇金持仓名单自 2026-05-01 新规后不再披露（基金定期报告删除前十大持有人条款），任何「国家队持仓」数字都无法验证');
  caveats.push('「主动净买入」= (外盘−内盘)/(外盘+内盘)×成交额，是逐笔成交方向推算，不是资金净流入、不是申赎数据');
  caveats.push('北向资金自 2024-08 取消盘中实时披露，本模块不使用任何「实时北向」口径');

  return {
    temperature, regime, headline, avg_index_pct: avgPct,
    signals, footprint, footprintText, summary, hitCount,
    how_to_read: '护盘资金一般靠三种方式托指数：买宽基ETF、拉权重股、拉银行券商。下面 4 条就是这几种动作的痕迹，命中越多越像。',
    caveats,
  };
}
