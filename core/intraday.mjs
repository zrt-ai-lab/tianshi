/**
 * 做T分析（日内高抛低吸）
 *
 * ⚠️ 硬约束（必须显示给用户）：
 *   1. A 股是 T+1，当天买的不能当天卖。所谓「做T」只能是用**已有底仓**先卖后买（正T），
 *      或先买后卖需要用次日可卖的老仓（反T），本质是在已有持仓上做差价，不是无本套利。
 *   2. 做T是高强度、高失败率的操作。本模块只给「今天适不适合做T、参考价位在哪」，
 *      不保证做T赚钱，也不推荐没底仓的人去做。
 *   3. 所有价位都由真实分时/盘口数据推导，标注计算方式，可复核。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 分时统计 */
export function intradayStats(points, preClose) {
  const pts = (points ?? []).filter((p) => isNum(p.close));
  if (!pts.length) return null;
  const closes = pts.map((p) => p.close);
  const highs = pts.map((p) => (isNum(p.high) ? p.high : p.close));
  const lows = pts.map((p) => (isNum(p.low) ? p.low : p.close));
  const last = closes[closes.length - 1];
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const avgLast = isNum(pts[pts.length - 1].avg) && pts[pts.length - 1].avg > 0
    ? pts[pts.length - 1].avg
    : closes.reduce((a, b) => a + b, 0) / closes.length;
  const base = isNum(preClose) && preClose > 0 ? preClose : closes[0];

  const amplitude = ((hi - lo) / base) * 100;
  const devFromAvg = ((last - avgLast) / avgLast) * 100;
  const posInRange = hi > lo ? ((last - lo) / (hi - lo)) * 100 : 50;

  // 日内高低点出现时间（判断是否冲高回落 / 探底回升）
  const hiIdx = highs.indexOf(hi);
  const loIdx = lows.indexOf(lo);
  const atOf = (i) => (pts[i]?.t ?? '').split(' ')[1] ?? '';

  // 量能分布：前 30 分钟与最后 30 分钟占比
  const vols = pts.map((p) => (isNum(p.volume) ? p.volume : 0));
  const totalVol = vols.reduce((a, b) => a + b, 0);
  let earlyVol = 0;
  let lateVol = 0;
  const n = pts.length;
  const earlyCut = Math.min(n, Math.max(1, Math.round(n * 0.15)));
  const lateStart = Math.max(0, n - Math.round(n * 0.15));
  for (let i = 0; i < n; i++) {
    if (i < earlyCut) earlyVol += vols[i];
    if (i >= lateStart) lateVol += vols[i];
  }
  const earlyPct = totalVol ? (earlyVol / totalVol) * 100 : null;
  const latePct = totalVol ? (lateVol / totalVol) * 100 : null;

  // 走势形态：用前后半段均价比较
  const half = Math.max(1, Math.floor(n / 2));
  const firstHalfAvg = closes.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const secondHalfAvg = closes.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, n - half);

  return {
    last, avg: avgLast, preClose: base,
    high: hi, low: lo,
    amplitude_pct: Number(amplitude.toFixed(2)),
    dev_from_avg_pct: Number(devFromAvg.toFixed(2)),
    pos_in_range_pct: Number(posInRange.toFixed(1)),
    high_time: atOf(hiIdx), low_time: atOf(loIdx),
    early_vol_pct: earlyPct === null ? null : Number(earlyPct.toFixed(1)),
    late_vol_pct: latePct === null ? null : Number(latePct.toFixed(1)),
    first_half_avg: Number(firstHalfAvg.toFixed(3)),
    second_half_avg: Number(secondHalfAvg.toFixed(3)),
    points: n,
  };
}

/** 盘口统计 */
export function orderBookStats(ob) {
  if (!ob || !Array.isArray(ob.bids) || !Array.isArray(ob.asks)) return null;
  const sum = (arr) => arr.reduce((a, x) => a + (isNum(x.vol) ? x.vol : 0), 0);
  const bidVol = sum(ob.bids);
  const askVol = sum(ob.asks);
  const bid1 = ob.bids[0]?.price ?? null;
  const ask1 = ob.asks[0]?.price ?? null;
  const spread = isNum(bid1) && isNum(ask1) && bid1 > 0 ? ((ask1 - bid1) / bid1) * 10000 : null;
  const depth = bidVol + askVol;
  return {
    bid_vol: bidVol, ask_vol: askVol,
    ratio: askVol > 0 ? Number((bidVol / askVol).toFixed(2)) : null, // >1 = 买盘厚
    spread_bp: spread === null ? null : Number(spread.toFixed(1)),   // 买卖价差（基点）
    depth_lots: depth,
    bid1, ask1,
    thin: depth > 0 && depth < 500 ? true : false,                   // 盘口薄，冲击成本高
  };
}

/**
 * 做T适宜度与策略
 * @param {object} s intradayStats
 * @param {object} ob orderBookStats
 * @param {object} ctx { pctChg, limitUp, riskLevel, stageKey }
 * @returns {{fitness:number, verdict:string, side:string, plan:object|null, reasons:string[], caveats:string[]}}
 */
export function buildTStrategy(s, ob, ctx = {}) {
  const reasons = [];
  const caveats = [];
  const verdictBase = {
    must_have_base: 'A股T+1：做T必须有底仓，当天买入的部分不能当天卖出',
    high_frequency: '做T失败率高，多数人做T做成加仓或割肉',
  };
  if (!s) {
    return { fitness: null, verdict: '数据不足', side: 'none', plan: null, reasons: ['没有分时数据'], caveats: [verdictBase.must_have_base] };
  }

  // 硬排除：涨停/跌停、单边趋势
  const pct = isNum(ctx.pctChg) ? ctx.pctChg : null;
  const isLimitUp = ctx.limitUp || (pct !== null && pct >= 9.7);
  const isLimitDown = pct !== null && pct <= -9.7;
  const oneWayDown = s.second_half_avg < s.first_half_avg * 0.995 && s.pos_in_range_pct < 30;
  const oneWayUp = s.second_half_avg > s.first_half_avg * 1.005 && s.pos_in_range_pct > 75;

  if (isLimitUp) {
    return { fitness: 0, verdict: '涨停，无法做T', side: 'none', plan: null, reasons: ['已封涨停，买不进也卖不出，只等次日'], caveats: [verdictBase.high_frequency] };
  }
  if (isLimitDown) {
    return { fitness: 0, verdict: '跌停，无法做T', side: 'none', plan: null, reasons: ['已跌停，流动性枯竭，别接飞刀'], caveats: [verdictBase.high_frequency] };
  }

  /* ── 适宜度打分 ── */
  let score = 0;
  const parts = [];

  // ① 振幅：越大越有做T空间，但过大说明风险高
  const amp = s.amplitude_pct;
  if (amp >= 1.5 && amp <= 6) { score += 30; parts.push(`日内振幅 ${amp}%，有做T空间`); }
  else if (amp > 6 && amp <= 9) { score += 18; parts.push(`振幅 ${amp}% 偏大，空间有但风险高`); }
  else if (amp < 1.5) { score += 4; parts.push(`振幅仅 ${amp}%，空间太小，不值得做`); }
  else { score += 8; parts.push(`振幅 ${amp}% 极端，容易一刀两面`); }

  // ② 与均价偏离：偏离越大越是高抛/低吸时机
  const dev = Math.abs(s.dev_from_avg_pct);
  if (dev >= 1.2) { score += 25; parts.push(`现价偏离均价 ${s.dev_from_avg_pct}%，位置明确`); }
  else if (dev >= 0.6) { score += 16; parts.push(`现价偏离均价 ${s.dev_from_avg_pct}%`); }
  else { score += 6; parts.push('现价贴着均价，没有明显高低点'); }

  // ③ 盘口厚度
  if (ob) {
    if (!ob.thin && ob.spread_bp !== null && ob.spread_bp <= 12) { score += 22; parts.push(`盘口厚度够、价差 ${ob.spread_bp}bp，进出成本低`); }
    else if (ob.thin) { score += 4; parts.push('盘口薄，冲击成本高，做T容易滑点'); }
    else { score += 12; parts.push(`价差 ${ob.spread_bp}bp`); }
    if (ob.ratio !== null) parts.push(`五档买卖比 ${ob.ratio}（>1 买盘厚）`);
  } else { score += 8; parts.push('盘口数据缺失，无法判断冲击成本'); }

  // ④ 形态：单边走势不适合逆势做T
  if (oneWayDown) { score -= 18; reasons.push('分时单边下行，逆势接飞刀胜率低'); }
  else if (oneWayUp) { score -= 8; reasons.push('分时单边上行，高抛容易把票抛飞'); }
  else { score += 15; parts.push('分时以震荡为主，适合高抛低吸'); }

  score = Math.max(0, Math.min(100, score));

  /* ── 策略 ── */
  let side = 'none';
  let verdict = '不建议做T';
  let plan = null;

  const canTrade = score >= 55;
  if (canTrade) {
    if (s.dev_from_avg_pct >= 0.8) {
      side = 'sell_first';
      verdict = '适合正T（先卖后买）';
      plan = {
        action: '先卖后买',
        base_position_note: '用手上已有的底仓做，不是新买',
        sell_zone: [Number(s.avg.toFixed(2)), Number((s.avg * 1.008).toFixed(2))],
        sell_reason: `现价高于均价 ${s.dev_from_avg_pct}%，是日内相对高位；挂均价附近卖出`,
        buy_back_zone: [Number((s.avg - (s.high - s.low) * 0.15).toFixed(2)), Number(s.avg.toFixed(2))],
        buy_reason: '回落到均价下方再接回，赚的是价差不是趋势',
        position_pct: 30,
        stop_rule: '接回后若继续跌破日内低点，说明判断错，认赔出局，不要再补',
      };
    } else if (s.dev_from_avg_pct <= -0.8) {
      side = 'buy_first';
      verdict = '适合反T（先买后卖）';
      plan = {
        action: '先买后卖',
        base_position_note: '用次日可卖的老仓对冲；新买的当天不能卖',
        buy_zone: [Number((s.avg * 0.992).toFixed(2)), Number(s.avg.toFixed(2))],
        buy_reason: `现价低于均价 ${Math.abs(s.dev_from_avg_pct)}%，是日内相对低位`,
        sell_zone: [Number(s.avg.toFixed(2)), Number((s.avg * 1.008).toFixed(2))],
        sell_reason: '反弹回均价上方卖出同等数量，赚差价',
        position_pct: 25,
        stop_rule: '若放量跌破日内低点，停止加买，等企稳',
      };
    } else {
      side = 'wait_sideways';
      verdict = '可等，但当前位置没有明显高低点';
      plan = {
        action: '等偏离',
        rule: `等价格偏离均价 ±0.8% 以上再动手（当前 ${s.dev_from_avg_pct}%）`,
        position_pct: 0,
      };
    }
  } else {
    reasons.push(`做T适宜度 ${score}/100，不够条件`);
  }

  /* ── 依据与警告 ── */
  if (s.high_time && s.low_time) {
    parts.push(`日内高点出现在 ${s.high_time}、低点在 ${s.low_time}`);
  }
  if (s.late_vol_pct !== null && s.late_vol_pct > 30) {
    caveats.push(`尾盘 30 分钟量能占比 ${s.late_vol_pct}%，说明尾盘博弈激烈，注意隔夜风险`);
  }

  return {
    fitness: score,
    verdict,
    side,
    plan,
    reasons: [...reasons, ...parts],
    caveats: [verdictBase.must_have_base, verdictBase.high_frequency],
    stats: s,
    orderbook: ob,
  };
}


/** 腾讯实时盘口（五档） */
export async function fetchOrderBook(code) {
  const mk = /^(6|68|5|11|51|58)/.test(String(code)) ? 'sh' : /^(9|4|8)/.test(String(code)) ? 'bj' : 'sz';
  const sym = `${mk}${code}`;
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${sym}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = new TextDecoder('gbk').decode(buf);
    const m = text.match(/v_[a-z]{2}\d{6}="([^"]*)"/);
    if (!m) return null;
    const f = m[1].split('~');
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const bids = [];
    const asks = [];
    for (let i = 0; i < 5; i++) {
      bids.push({ price: num(f[9 + i * 2]), vol: num(f[10 + i * 2]) });
      asks.push({ price: num(f[19 + i * 2]), vol: num(f[20 + i * 2]) });
    }
    return {
      name: f[1], price: num(f[3]), pre_close: num(f[4]), open: num(f[5]),
      volume_lots: num(f[6]), outer: num(f[7]), inner: num(f[8]),
      amount: num(f[37]) === null ? null : num(f[37]) * 1e4,
      time: f[30] ?? null,
      bids, asks,
    };
  } catch {
    return null;
  }
}
