/**
 * 妖股阶段扫描器
 *
 * 核心认知（这也是之前做错的地方）：
 *   妖股不是「一直涨停的票」，而是一条有阶段的路：
 *     埋伏 → 试盘启动 → 一波主升 → 二波/三波 → 见顶退潮
 *   而且「涨起来之后才有人讲故事」——所以**题材/新闻不能作为事前筛选条件**，
 *   事后叙事不是原因。事前能看的只有：位置、量能、筹码结构、均线形态、流通盘。
 *
 * 因此本模块不依赖涨停池，而是在**全市场**上按阶段特征扫描，
 * 每只票给出：所处阶段、各项特征值、为什么被选中、以及风险点。
 *
 * 诚实边界：
 *   1. 阶段判断是形态识别，不是预测。处在「启动期」的票很多最后会失败。
 *   2. 不给胜率、不给目标价。只回答「它现在像哪个阶段」。
 *   3. 所有阈值都是显式常量，可复核、可调整。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

async function getJson(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/* ══════════ 阶段定义（阈值全部显式写在这里） ══════════ */

export const STAGES = {
  ambush: {
    key: 'ambush', name: '埋伏期', order: 1,
    mean: '长期低位横盘、缩量、均线粘合，还没启动',
    action: '只能小仓位试探性埋伏，等放量突破再确认；不启动就一直不动',
    risk: '埋伏最大的风险是「永远不启动」，资金占用成本高',
  },
  launch: {
    key: 'launch', name: '启动期', order: 2,
    mean: '放量突破平台、均线刚转多，第一波正在起',
    action: '这是赔率最好的位置：突破当日或回踩不破可以参与，跌回平台就走',
    risk: '假突破很多，尤其大盘弱的时候；必须设明确的失败点',
  },
  wave1: {
    key: 'wave1', name: '一波主升', order: 3,
    mean: '趋势确立，沿 MA10/MA20 上行，市场开始讲故事',
    action: '持有为主，不追高；跌破 MA10 减仓',
    risk: '此时消息最多、情绪最热，也最容易接最后一棒',
  },
  wave2: {
    key: 'wave2', name: '二波/三波', order: 4,
    mean: '第一波调整后再起，常有加速段',
    action: '只做回踩确认后的再启动，不猜顶',
    risk: '二波失败率高，且一旦失败跌幅大；仓位要小于一波',
  },
  climax: {
    key: 'climax', name: '高位风险区', order: 5,
    mean: '涨幅巨大、位置极高、放量滞涨或频繁炸板',
    action: '只减不加；跌破 MA10 或放量长阴就走',
    risk: '这是最容易亏钱的阶段，故事最动听的时候往往就是顶部',
  },
  idle: {
    key: 'idle', name: '无特征', order: 0,
    mean: '没有明显阶段特征',
    action: '观望',
    risk: '',
  },
};

const T = {
  // 埋伏期
  ambush: {
    ret60Max: 22,          // 60 日涨幅不超过 22%
    pos120Max: 50,         // 120 日区间位置低于 50%
    maSpreadMax: 13,       // 均线极化差 ≤ 13%（相对粘合）
    volRatio5_20Max: 1.15, // 5 日/20 日均量 ≤ 1.15（未放量）
    dayRangeMax: 4.5,      // 近 20 日平均振幅 ≤ 4.5%
  },
  // 启动期
  launch: {
    ret60Min: 12, ret60Max: 70,
    volRatio5_20Min: 1.25,
    breakoutLookback: 60,  // 突破 60 日新高
    pos120Min: 55,
  },
  // 一波主升
  wave1: { ret60Min: 55, ret60Max: 160, pos120Min: 75, maSpreadMin: 8 },
  // 二波/三波
  wave2: { ret60Min: 90, ret120Min: 120, pos120Min: 88, pullbackFromHighMin: 8, pullbackFromHighMax: 30 },
  // 高位风险
  climax: { ret60Min: 150, pos120Min: 94 },
};

/* ══════════ 单只股票特征计算 ══════════ */

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const maAt = (closes, n, offset = 0) => {
  const end = closes.length - offset;
  const seg = closes.slice(Math.max(0, end - n), end);
  return seg.length === n ? mean(seg) : null;
};

/** 计算一只股票的全部形态特征 */
export function computeFeatures(bars, quote = {}) {
  const list = (bars ?? []).filter((b) => isNum(b.close) && b.close > 0 && isNum(b.high) && isNum(b.low));
  if (list.length < 70) return null;
  const n = list.length;
  const closes = list.map((b) => b.close);
  const highs = list.map((b) => b.high);
  const lows = list.map((b) => b.low);
  const vols = list.map((b) => (isNum(b.volume) ? b.volume : 0));
  const last = closes[n - 1];

  const ret = (k) => (n > k ? ((last - closes[n - 1 - k]) / closes[n - 1 - k]) * 100 : null);

  const lookback = Math.min(120, n);
  const hi = Math.max(...highs.slice(-lookback));
  const lo = Math.min(...lows.slice(-lookback));
  const pos120 = hi > lo ? ((last - lo) / (hi - lo)) * 100 : 50;

  const ma5 = maAt(closes, 5);
  const ma10 = maAt(closes, 10);
  const ma20 = maAt(closes, 20);
  const ma60 = maAt(closes, 60);
  const mas = [ma5, ma10, ma20, ma60].filter(isNum);
  const maSpread = mas.length >= 2 ? ((Math.max(...mas) - Math.min(...mas)) / Math.min(...mas)) * 100 : null;
  const bullAlign = isNum(ma5) && isNum(ma10) && isNum(ma20) && isNum(ma60)
    ? (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) : false;

  const v5 = mean(vols.slice(-5));
  const v20 = mean(vols.slice(-20));
  const v60 = mean(vols.slice(-60));
  const volRatio5_20 = v5 && v20 ? v5 / v20 : null;
  const volRatio5_60 = v5 && v60 ? v5 / v60 : null;

  // 近 20 日平均振幅
  const amps = [];
  for (let i = Math.max(1, n - 20); i < n; i++) amps.push(((highs[i] - lows[i]) / closes[i - 1]) * 100);
  const avgAmp20 = mean(amps);

  // 平台突破：过去 60 日（不含最近 3 日）的最高价
  const priorHi = n > 63 ? Math.max(...highs.slice(-63, -3)) : null;
  const breakout = isNum(priorHi) ? last > priorHi : false;
  const breakoutPct = isNum(priorHi) ? ((last - priorHi) / priorHi) * 100 : null;

  // 大阳天数（涨幅 ≥5%）
  let bigUp5 = 0;
  let bigUp10 = 0;
  for (let i = Math.max(1, n - 5); i < n; i++) {
    const chg = ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100;
    if (chg >= 5) bigUp5++;
    if (chg >= 9.5) bigUp10++;
  }

  // 涨停基因：近 90 日涨停次数与最大连板
  // 涨停基因：近 90 日涨停次数与最大连板（按板块涨停幅度判定，双创 20%、北交所 30%、ST 5%）
  const code = String(quote.code ?? '');
  const limitPct = /^(83|87|88|92|43)/.test(code) ? 29.4 : /^(30|68)/.test(code) ? 19.4 : /ST/i.test(String(quote.name ?? '')) ? 4.6 : 9.4;
  let limitUps90 = 0;
  let maxConsecutive = 0;
  let cur = 0;
  const isLimitAt = (i) => i > 0 && ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100 >= limitPct;
  const startIdx = Math.max(1, n - 90);
  for (let i = startIdx; i < n; i++) {
    if (isLimitAt(i)) { limitUps90++; cur += 1; maxConsecutive = Math.max(maxConsecutive, cur); }
    else cur = 0;
  }

  // 本轮启动点：近 40 个交易日内第一个涨停（没有涨停则取放量突破 20 日高点那天）
  let launchIdx = -1;
  for (let i = Math.max(1, n - 40); i < n; i++) { if (isLimitAt(i)) { launchIdx = i; break; } }
  if (launchIdx < 0) {
    for (let i = Math.max(21, n - 40); i < n; i++) {
      const prevHi = Math.max(...highs.slice(i - 20, i));
      if (closes[i] > prevHi && vols[i] > (mean(vols.slice(i - 20, i)) || 0) * 1.8) { launchIdx = i; break; }
    }
  }
  const launch = launchIdx > 0 ? (() => {
    const base = closes[launchIdx - 1];
    const win = list.slice(Math.max(0, launchIdx - 120), launchIdx);
    const h2 = Math.max(...win.map((b) => b.high)), l2 = Math.min(...win.map((b) => b.low));
    return {
      date: list[launchIdx].date ?? null,
      price: Number(base.toFixed(2)),
      pos_before: h2 > l2 ? Number((((base - l2) / (h2 - l2)) * 100).toFixed(1)) : null,
      gain_since: Number((((last - base) / base) * 100).toFixed(1)),
    };
  })() : null;
  const ret30 = n > 30 ? ((last - closes[n - 31]) / closes[n - 31]) * 100 : null;
  // 近 5 日是否出现跌停（退潮信号）
  let limitDown5 = 0;
  for (let i = Math.max(1, n - 5); i < n; i++) {
    if (((closes[i] - closes[i - 1]) / closes[i - 1]) * 100 <= -limitPct) limitDown5++;
  }

  // 距 120 日高点回撤
  const fromHigh = hi > 0 ? ((last - hi) / hi) * 100 : 0;

  return {
    last,
    bars: n,
    ret5: ret(5) === null ? null : Number(ret(5).toFixed(1)),
    ret10: ret(10) === null ? null : Number(ret(10).toFixed(1)),
    ret20: ret(20) === null ? null : Number(ret(20).toFixed(1)),
    ret60: ret(60) === null ? null : Number(ret(60).toFixed(1)),
    ret120: ret(120) === null ? null : Number(ret(120).toFixed(1)),
    pos120: Number(pos120.toFixed(1)),
    from_high: Number(fromHigh.toFixed(1)),
    ma5, ma10, ma20, ma60,
    ma_spread: maSpread === null ? null : Number(maSpread.toFixed(1)),
    bull_align: bullAlign,
    vol_ratio_5_20: volRatio5_20 === null ? null : Number(volRatio5_20.toFixed(2)),
    vol_ratio_5_60: volRatio5_60 === null ? null : Number(volRatio5_60.toFixed(2)),
    avg_amp20: avgAmp20 === null ? null : Number(avgAmp20.toFixed(2)),
    breakout,
    breakout_pct: breakoutPct === null ? null : Number(breakoutPct.toFixed(1)),
    big_up_5d: bigUp5,
    big_up_10d: bigUp10,
    limit_ups_90d: limitUps90,
    launch,
    ret30: ret30 === null ? null : Number(ret30.toFixed(1)),
    limit_down_5d: limitDown5,
    max_consecutive_90d: maxConsecutive,
    price: isNum(quote.price) ? quote.price : last,
    float_cap_yi: isNum(quote.float_cap) ? Number((quote.float_cap / 1e8).toFixed(1)) : null,
    turnover: isNum(quote.turnover) ? quote.turnover : null,
    pe: isNum(quote.pe) ? quote.pe : null,
  };
}

/* ══════════ 阶段判定 ══════════ */

export function classifyStage(f) {
  if (!f) return STAGES.idle;
  const r60 = f.ret60 ?? 0;
  const r120 = f.ret120 ?? 0;

  // 高位风险优先判定：必须「先涨过高位」，纯下跌股不算妖股风险区
  const hadRun = r60 >= 60 || (f.ret120 ?? 0) >= 100;
  if (r60 >= T.climax.ret60Min && f.pos120 >= T.climax.pos120Min) return STAGES.climax;
  if (hadRun && f.from_high <= -25) return STAGES.climax;       // 涨完已经破位下跌
  if (hadRun && f.ret5 !== null && f.ret5 < -8) return STAGES.climax; // 高位急跌
  // 二波/三波：涨幅已大，但从高点回撤过一段又开始走强
  if (hadRun && f.pos120 >= 80 &&
      f.from_high <= -8 && f.from_high >= -30 &&
      (f.ret5 ?? 0) > 2) {
    return STAGES.wave2;
  }
  // 一波主升
  if (r60 >= T.wave1.ret60Min && f.pos120 >= T.wave1.pos120Min &&
      (f.ma_spread === null || f.ma_spread >= T.wave1.maSpreadMin)) {
    return STAGES.wave1;
  }
  // 启动期
  if (r60 >= T.launch.ret60Min && r60 < T.launch.ret60Max &&
      f.vol_ratio_5_20 !== null && f.vol_ratio_5_20 >= T.launch.volRatio5_20Min &&
      f.pos120 >= T.launch.pos120Min) {
    return STAGES.launch;
  }
  // 埋伏期
  if (r60 <= T.ambush.ret60Max && f.pos120 <= T.ambush.pos120Max &&
      (f.ma_spread === null || f.ma_spread <= T.ambush.maSpreadMax) &&
      (f.vol_ratio_5_20 === null || f.vol_ratio_5_20 <= T.ambush.volRatio5_20Max) &&
      (f.avg_amp20 === null || f.avg_amp20 <= T.ambush.dayRangeMax)) {
    return STAGES.ambush;
  }
  return STAGES.idle;
}

/* ══════════ 阶段内打分（越高越符合该阶段的妖股形态） ══════════ */

export function scoreByStage(stage, f) {
  const reasons = [];
  const risks = [];
  let score = 0;

  const cheap = isNum(f.price) && f.price <= 12;
  const smallCap = isNum(f.float_cap_yi) && f.float_cap_yi <= 100;

  if (stage.key === 'ambush') {
    // 埋伏：越"死"越好——低位、缩量、窄幅、粘合
    if (f.ret60 !== null && f.ret60 <= 5) { score += 22; reasons.push(`60 日仅 ${f.ret60.toFixed(1)}%，基本没涨，筹码在低位`); }
    else if (f.ret60 !== null && f.ret60 <= 18) { score += 14; reasons.push(`60 日 ${f.ret60.toFixed(1)}%，涨幅温和`); }
    if (f.pos120 <= 25) { score += 18; reasons.push(`120 日区间位置 ${f.pos120}%，处于底部区域`); }
    else if (f.pos120 <= 45) { score += 10; reasons.push(`120 日区间位置 ${f.pos120}%`); }
    if (f.ma_spread !== null && f.ma_spread <= 5) { score += 16; reasons.push(`均线极化差 ${f.ma_spread}%，粘合充分`); }
    else if (f.ma_spread !== null && f.ma_spread <= 9) { score += 10; reasons.push(`均线极化差 ${f.ma_spread}%`); }
    if (f.vol_ratio_5_20 !== null && f.vol_ratio_5_20 <= 0.85) { score += 16; reasons.push(`量能萎缩到 20 日均量的 ${(f.vol_ratio_5_20 * 100).toFixed(0)}%，无人问津`); }
    if (f.avg_amp20 !== null && f.avg_amp20 <= 2.5) { score += 12; reasons.push(`20 日均振幅仅 ${f.avg_amp20}%，横得住`); }
    if (cheap) { score += 10; reasons.push(`股价 ${f.price} 元，低价`); }
    if (smallCap) { score += 8; reasons.push(`流通 ${f.float_cap_yi} 亿，小盘`); }
    risks.push('埋伏期没有时间表，可能横很久不启动，机会成本是最大风险');
    risks.push('需要设一个「明确失败点」：跌破 120 日新低就走，不要无限期扛');
  }

  if (stage.key === 'launch') {
    if (f.breakout) { score += 24; reasons.push(`放量突破近 60 日平台高点（超出 ${f.breakout_pct}%）`); }
    if (f.vol_ratio_5_20 !== null && f.vol_ratio_5_20 >= 1.6) { score += 18; reasons.push(`5 日量能是 20 日均量的 ${f.vol_ratio_5_20} 倍，明显放量`); }
    else if (f.vol_ratio_5_20 !== null && f.vol_ratio_5_20 >= 1.25) { score += 12; reasons.push(`量能放大到 ${f.vol_ratio_5_20} 倍`); }
    if (f.bull_align) { score += 16; reasons.push('均线多头排列刚刚形成（MA5>10>20>60）'); }
    if (f.ret20 !== null && f.ret20 >= 8 && f.ret20 <= 40) { score += 12; reasons.push(`20 日涨 ${f.ret20.toFixed(1)}%，启动初期`); }
    if (f.pos120 >= 55 && f.pos120 <= 85) { score += 8; reasons.push(`突破但位置不高（${f.pos120}%），后面还有空间`); }
    else if (f.pos120 > 85) { score -= 8; risks.push(`位置已到 ${f.pos120}%，不是启动位而是追高位`); }
    if (cheap) { score += 6; reasons.push(`股价 ${f.price} 元偏低，容易被资金选为标的`); }
    if (smallCap) { score += 6; reasons.push(`流通 ${f.float_cap_yi} 亿，盘子轻`); }
    risks.push('假突破是常态：跌回突破平台下沿就要认错，别把失败当回踩');
  }

  if (stage.key === 'wave1') {
    if (f.ret60 !== null && f.ret60 >= 80) { score += 22; reasons.push(`60 日大涨 ${f.ret60.toFixed(0)}%，已是市场焦点`); }
    else { score += 14; reasons.push(`60 日涨 ${(f.ret60 ?? 0).toFixed(0)}%`); }
    if (f.bull_align) { score += 16; reasons.push('均线完全多头，趋势健康'); }
    if (f.vol_ratio_5_60 !== null && f.vol_ratio_5_60 >= 1.3) { score += 14; reasons.push(`5 日量能是 60 日均量的 ${f.vol_ratio_5_60} 倍，资金仍在流入`); }
    if (f.vol_ratio_5_20 !== null && f.vol_ratio_5_20 <= 1.3) { score += 8; reasons.push('近期量能未异常放大，还没到疯狂阶段'); }
    if (f.pos120 >= 85) { score += 8; reasons.push(`位置 ${f.pos120}%，趋势强劲`); }
    if (f.ret5 !== null && f.ret5 < -6) risks.push(`近 5 日跌 ${Math.abs(f.ret5).toFixed(1)}%，可能进入调整`);
    risks.push('这个阶段消息最多、故事最动听，恰恰是风险开始累积的时候');
    risks.push('跌破 MA10 先减一半，跌破 MA20 全部离场');
  }

  if (stage.key === 'wave2') {
    if (f.from_high !== null && f.from_high <= -10) { score += 18; reasons.push(`从高点回撤 ${Math.abs(f.from_high).toFixed(0)}% 后重新走强`); }
    if (f.ret5 !== null && f.ret5 > 3) { score += 14; reasons.push(`近 5 日涨 ${f.ret5.toFixed(1)}%，二次启动迹象`); }
    if (f.vol_ratio_5_20 !== null && f.vol_ratio_5_20 >= 1.2) { score += 12; reasons.push(`二次启动量能是 20 日均量的 ${f.vol_ratio_5_20} 倍`); }
    if (f.pos120 >= 90) { score += 8; reasons.push('仍在高位区间'); }
    risks.push('二波/三波的失败率明显高于一波，一旦失败跌幅更大');
    risks.push('仓位必须小于一波，且只做回踩确认后的再启动，不猜顶');
  }

  if (stage.key === 'climax') {
    score += 40;
    if (f.ret60 !== null) reasons.push(`60 日已涨 ${f.ret60.toFixed(0)}%`);
    if (f.pos120 >= 95) reasons.push(`位置 ${f.pos120}%，接近区间顶部`);
    if (f.vol_ratio_5_20 !== null && f.vol_ratio_5_20 >= 1.5) risks.push('高位放量，需警惕出货');
    if (f.ret5 !== null && f.ret5 < 0) risks.push('近期已走弱，可能进入退潮');
    risks.push('高风险区：只减不加。故事最动听的时候往往就是顶部');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    risks,
  };
}

/* ══════════ 全市场扫描 ══════════ */

let universeCache = { at: 0, items: [] };
const UNIVERSE_TTL = 10 * 60 * 1000;
let scanCache = { at: 0, data: null };
const SCAN_TTL = 30 * 60 * 1000;

/** 全市场行情快照（价格/涨跌/成交额/换手/流通市值） */
export async function fetchUniverse() {
  if (universeCache.items.length && Date.now() - universeCache.at < UNIVERSE_TTL) return universeCache.items;
  const fs = ['m:0+t:6', 'm:0+t:80', 'm:1+t:2', 'm:1+t:23', 'm:0+t:81+s:2048'].join(',');
  const PAGE = 100;
  const items = [];
  async function page(pn) {
    const j = await getJson(
      `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${PAGE}&po=1&np=1&fltt=2&invt=2&fid=f3` +
      `&fs=${encodeURIComponent(fs)}&fields=f2,f3,f6,f8,f9,f12,f14,f21`,
    );
    return { rows: j?.data?.diff ?? [], total: Number(j?.data?.total) || 0 };
  }
  try {
    const first = await page(1);
    const pages = Math.min(70, Math.max(1, Math.ceil((first.total || 0) / PAGE)));
    const collect = (rows) => {
      for (const r of rows) {
        const code = String(r.f12 ?? '');
        const name = String(r.f14 ?? '');
        if (!/^\d{6}$/.test(code) || !name) continue;
        items.push({
          code, name,
          price: isNum(r.f2) ? r.f2 : null,
          pct: isNum(r.f3) ? r.f3 : null,
          amount: isNum(r.f6) ? r.f6 : null,
          turnover: isNum(r.f8) ? r.f8 : null,
          pe: isNum(r.f9) ? r.f9 : null,
          float_cap: isNum(r.f21) ? r.f21 : null,
        });
      }
    };
    collect(first.rows);
    for (let s = 2; s <= pages; s += 6) {
      const batch = [];
      for (let p = s; p < s + 6 && p <= pages; p++) batch.push(page(p).catch(() => ({ rows: [] })));
      (await Promise.all(batch)).forEach((r) => collect(r.rows));
    }
  } catch { return universeCache.items; }
  if (items.length) universeCache = { at: Date.now(), items };
  return items;
}

/** 批量取日 K（并发 8） */
async function fetchKlines(codes, lmt = 130) {
  const out = new Map();
  const CONC = 8;
  for (let i = 0; i < codes.length; i += CONC) {
    const batch = codes.slice(i, i + CONC);
    await Promise.all(batch.map(async (code) => {
      const mk = /^(6|9)/.test(code) ? '1' : '0';
      try {
        const j = await getJson(
          `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${mk}.${code}` +
          `&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${lmt}`,
          8000,
        );
        const bars = (j?.data?.klines ?? []).map((l) => {
          const p = l.split(',');
          return { date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4], volume: +p[5], amount: +p[6] };
        });
        if (bars.length >= 70) out.set(code, bars);
      } catch { /* 单只失败跳过 */ }
    }));
  }
  return out;
}

/**
 * 扫描：按阶段输出候选
 * @param {{maxPerStage?:number, universeLimit?:number}} opts
 */
export async function scanMonsters(opts = {}) {
  const { maxPerStage = 8, universeLimit = 260 } = opts;
  if (scanCache.data && Date.now() - scanCache.at < SCAN_TTL) return scanCache.data;

  const [uni, indexBars] = await Promise.all([fetchUniverse(), fetchIndexKline()]);
  if (!uni.length) return { ok: false, error: '全市场名录取数失败' };

  // 初筛：可交易、有流动性、价格与盘子符合游资偏好范围
  const base = uni.filter((s) =>
    s.price !== null && s.price >= 2 && s.price <= 45 &&
    s.float_cap !== null && s.float_cap >= 15e8 && s.float_cap <= 600e8 &&
    s.amount !== null && s.amount >= 1500e4 &&
    !/ST|退|退市/.test(s.name));

  // 两路取样：活跃票（成交额高）+ 低位小盘（埋伏候选）
  const byAmount = base.slice().sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, Math.round(universeLimit * 0.65));
  const byQuiet = base
    .filter((s) => (s.float_cap ?? 1e12) <= 200e8 && (s.price ?? 99) <= 20 && (s.turnover ?? 99) <= 6)
    .sort((a, b) => (a.float_cap ?? 0) - (b.float_cap ?? 0))
    .slice(0, Math.round(universeLimit * 0.35));
  const picks = [...new Map([...byAmount, ...byQuiet].map((s) => [s.code, s])).values()];

  const klines = await fetchKlines(picks.map((s) => s.code));

  const buckets = { ambush: [], launch: [], wave1: [], wave2: [], climax: [] };
  for (const s of picks) {
    const bars = klines.get(s.code);
    if (!bars) continue;
    const f = computeFeatures(bars, { code: s.code, name: s.name, price: s.price, float_cap: s.float_cap, turnover: s.turnover, pe: s.pe });
    if (!f) continue;
    const stage = classifyStage(f);
    if (stage.key === 'idle') continue;
    const rs = computeRelativeStrength(bars, indexBars);
    const sc = scoreByStage(stage, f);
    const minScore = stage.key === 'ambush' || stage.key === 'launch' ? 35 : 40;
    if (sc.score < minScore) continue;
    buckets[stage.key].push({
      code: s.code, name: s.name, stage: stage.key, stage_name: stage.name,
      score: sc.score, reasons: sc.reasons, risks: sc.risks,
      features: f, rs,
      bars_cache: null,
    });
  }

  // 对每个阶段的前 12 名补查主力资金与龙虎榜，再重排
  const enrichTargets = [];
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => b.score - a.score);
    for (const item of buckets[key].slice(0, 12)) enrichTargets.push(item);
  }
  const CONC = 6;
  for (let i = 0; i < enrichTargets.length; i += CONC) {
    await Promise.all(enrichTargets.slice(i, i + CONC).map(async (item) => {
      const [fund, bb] = await Promise.all([
        fetchFundFlow(item.code).catch(() => null),
        fetchBillboard(item.code).catch(() => null),
      ]);
      item.fund = fund;
      item.billboard = bb;
      const extra = scoreFundAndProfile(item.features, fund, bb, item.stage);
      // 形态分（最高 78）+ 资金/跨年加分（最高 22），避免全部顶到 100 失去区分度
      const base = Math.round(item.score * 0.78);
      const bonus = Math.max(-12, Math.min(15, extra.bonus));
      item.score = Math.max(0, Math.min(100, base + bonus));
      item.score_base = item.score === null ? null : base;
      item.score_bonus = bonus;
      item.reasons = [...(item.reasons || []), ...extra.reasons];
      item.risks = [...(item.risks || []), ...extra.risks];
    }));
  }

  // 二次补查：对每个阶段前 6 名取概念/筹码/杠杆/解禁，重排
  const extraTargets = [];
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => b.score - a.score);
    for (const item of buckets[key].slice(0, 6)) extraTargets.push(item);
  }
  const CONC2 = 6;
  for (let i = 0; i < extraTargets.length; i += CONC2) {
    await Promise.all(extraTargets.slice(i, i + CONC2).map(async (item) => {
      const extra = await fetchExtraProfile(item.code).catch(() => null);
      item.profile = extra;
      const add = scoreExtraProfile(item.features, extra, item.stage);
      item.score_bonus = Math.max(-25, Math.min(30, (item.score_bonus || 0) + add.bonus));
      item.reasons = [...(item.reasons || []), ...add.reasons];
      item.risks = [...(item.risks || []), ...add.risks];
      item.score = Math.max(0, Math.min(100, (item.score_base || 0) + item.score_bonus));

      // 两个独立概念：妖股潜质（强度） vs 跨年妖候选（日历+五特征）
      const pot = scorePotential(item.features, item.rs, item.fund, item.billboard);
      item.potential = pot;
      const win = (new Date().getMonth() + 1);
      const inWindow = win === 11 || win === 12 || win === 1;
      item.cross_year_extra = inWindow ? await fetchCrossYearExtra(item.code).catch(() => null) : null;
      item.cross_year = crossYearEligibility(item.features, item.profile, inWindow, item.cross_year_extra);
      item.reasons = [...(item.reasons || []), ...pot.reasons];
      item.risks = [...new Set([...(item.risks || []), ...pot.risks])];
    }));
  }

  // 汇总潜质榜与跨年候选榜（与阶段分类独立的两个视角）
  const all = Object.values(buckets).flat();
  const potentialTop = all.slice().sort((a, b) => (b.potential?.score ?? 0) - (a.potential?.score ?? 0)).slice(0, 15);
  const crossYearTop = all.filter((x) => x.cross_year?.eligible)
    .sort((a, b) => (b.cross_year?.score ?? 0) - (a.cross_year?.score ?? 0)).slice(0, 15);
  const monthNow = new Date().getMonth() + 1;
  const windowActive = monthNow === 11 || monthNow === 12 || monthNow === 1;

  const result = {
    ok: true, scanned: picks.length, universe: uni.length, at: new Date().toISOString(),
    stages: {}, potential_top: potentialTop, cross_year_top: crossYearTop,
    window_active: windowActive, window_month: monthNow,
    cross_year_rules: CROSS_YEAR_RULES,
  };
  for (const key of Object.keys(buckets)) {
    result.stages[key] = {
      ...STAGES[key],
      count: buckets[key].length,
      items: buckets[key].sort((a, b) => b.score - a.score).slice(0, maxPerStage),
    };
  }
  scanCache = { at: Date.now(), data: result };
  return result;
}

/* ══════════ 跨年妖特征（来自公开统计） ══════════ */
/**
 * 依据证券时报·数据宝对 2020-2024 年「跨年强势股」的统计（每年 11 月至次年 1 月
 * 区间涨幅 >100% 的个股），启动前普遍具备五个特征：
 *   1. 市值小：2023 年中位数不足 18 亿、2024 年不足 34 亿，均显著低于 A 股整体（>50 亿）
 *   2. 股价低：2023 年中位数低于 6 元；2024 年为 16.65 元，接近整体
 *   3. 活跃度高：10 月月均换手率中位数超过整体，2024 年超 9%（约为整体 1.6 倍）
 *   4. 估值低：PE 中位数低于整体（2023 年约 16 倍，整体超 24 倍）
 *   5. 涉及热门概念较多
 * 参考：https://www.sohu.com/a/952322414_115433 （证券时报·数据宝，2025-11-08）
 *
 * 注意：这是历史统计的「共同特征」，不是充分条件。符合这五条的票绝大多数也不会成妖。
 */
export const CROSS_YEAR_PROFILE = {
  float_cap_yi: { median_2023: 18, median_2024: 34, whole_market_median: 50 },
  price: { median_2023: 6, median_2024: 16.65 },
  month_turnover_pct: { median_2024: 9, vs_market: 1.6 },
  pe_ttm: { median_2023: 16, whole_market_median: 24 },
  concepts: '热门概念数较多（本系统暂未接入概念数量统计，见 caveat）',
  source: '证券时报·数据宝 2020-2024 跨年强势股统计',
};

/* ══════════ 主力资金 ══════════ */

/** 近 20 日主力资金明细 → 资金结构特征 */
export async function fetchFundFlow(code) {
  const mk = /^(6|9)/.test(code) ? '1' : '0';
  try {
    const j = await getJson(
      `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${mk}.${code}` +
      `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65&klt=101&lmt=30`,
      8000,
    );
    const rows = (j?.data?.klines ?? []).map((l) => {
      const p = l.split(',');
      return { date: p[0], main: +p[1], small: +p[2], medium: +p[3], large: +p[4], super: +p[5] };
    }).filter((r) => Number.isFinite(r.main));
    if (!rows.length) return null;
    const sum = (arr, n) => arr.slice(-n).reduce((a, r) => a + r.main, 0);
    const last = rows[rows.length - 1];
    // 连续净流入天数
    let streak = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].main > 0) streak++;
      else break;
    }
    let outStreak = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].main < 0) outStreak++;
      else break;
    }
    return {
      days: rows.length,
      last_date: last.date,
      main_today: last.main,
      main_5d: sum(rows, 5),
      main_10d: sum(rows, 10),
      main_20d: sum(rows, 20),
      super_5d: rows.slice(-5).reduce((a, r) => a + r.super, 0),
      large_5d: rows.slice(-5).reduce((a, r) => a + r.large, 0),
      small_5d: rows.slice(-5).reduce((a, r) => a + r.small, 0),
      inflow_streak: streak,
      outflow_streak: outStreak,
      positive_days_20: rows.slice(-20).filter((r) => r.main > 0).length,
    };
  } catch { return null; }
}

/* ══════════ 龙虎榜 / 游资席位 ══════════ */

/**
 * 公开报道整理的知名游资常用席位关键词。
 * ⚠️ 席位归属会变化，这里只做「疑似」提示，且只加很小权重，不作为主要依据。
 */
export const FAMOUS_SEATS = [
  '华鑫证券上海分公司',
  '华鑫证券上海宛平南路',
  '中国银河证券绍兴',
  '财通证券杭州上塘路',
  '国泰君安南京太平南路',
  '光大证券佛山季华六路',
  '国信证券深圳振华路',
  '东方财富证券拉萨团结路第二',
  '东方财富证券拉萨东环路第二',
  '中信证券上海溧阳路',
  '华泰证券深圳益田路荣超商务中心',
  '国盛证券宁波桑田路',
];

/** 近 30 日龙虎榜：游资参与度 */
export async function fetchBillboard(code) {
  try {
    const j = await getJson(
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BILLBOARD_DAILYDETAILSBUY` +
      `&columns=ALL&filter=(SECURITY_CODE%3D%22${encodeURIComponent(code)}%22)&pageNumber=1&pageSize=30` +
      `&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB`,
      8000,
    );
    const rows = j?.result?.data ?? [];
    if (!rows.length) return { count: 0, seats: [], net: 0, institution: 0, famous: [] };
    const dates = [...new Set(rows.map((r) => String(r.TRADE_DATE).slice(0, 10)))].slice(0, 5);
    const seats = [];
    const famous = new Set();
    let net = 0;
    let institution = 0;
    for (const r of rows || []) {
      const name = String(r.OPERATEDEPT_NAME ?? '');
      if (!name) continue;
      const isInst = name.includes('机构专用');
      if (isInst) institution++;
      if (FAMOUS_SEATS.some((k) => name.includes(k))) famous.add(name);
      const buy = Number(r.BUY) || 0;
      const sell = Number(r.SELL) || 0;
      net += buy - sell;
      if (seats.length < 8) seats.push({ name, buy, sell, is_institution: isInst });
    }
    return {
      count: rows.length,
      days: dates.length,
      last_date: dates[0] ?? null,
      seats,
      net,
      institution,
      famous: [...famous],
    };
  } catch { return null; }
}

/* ══════════ 资金 + 跨年特征加分 ══════════ */

/** 把资金与跨年特征合成为额外加分与说明 */
export function scoreFundAndProfile(f, fund, bb, stageKey) {
  const reasons = [];
  const risks = [];
  let bonus = 0;

  /* 主力资金 */
  if (fund) {
    const yi = (v) => (v / 1e8).toFixed(2);
    if (fund.main_5d > 0 && fund.main_20d > 0) {
      bonus += 8;
      reasons.push(`主力资金 5 日 +${yi(fund.main_5d)} 亿、20 日 +${yi(fund.main_20d)} 亿，持续流入`);
    } else if (fund.main_5d > 0 && fund.main_20d <= 0) {
      bonus += 5;
      reasons.push(`主力资金近 5 日转流入 +${yi(fund.main_5d)} 亿（20 日仍为 ${yi(fund.main_20d)} 亿），疑似回补`);
    } else if (fund.main_5d < 0 && fund.main_20d > 0) {
      bonus -= 3;
      risks.push(`20 日净流入但近 5 日转为流出 ${yi(fund.main_5d)} 亿，短线资金在撤`);
    } else {
      bonus -= 8;
      risks.push(`主力资金近 5 日与 20 日均净流出，缺少资金支持`);
    }
    if (fund.inflow_streak >= 3) { bonus += 4; reasons.push(`连续 ${fund.inflow_streak} 日主力净流入`); }
    if (fund.outflow_streak >= 3) { bonus -= 4; risks.push(`连续 ${fund.outflow_streak} 日主力净流出`); }
    if (fund.positive_days_20 >= 13) { bonus += 3; reasons.push(`近 20 日有 ${fund.positive_days_20} 天净流入，资金持续性较好`); }
    // 大单与散户背离
    if (fund.super_5d + fund.large_5d > 0 && fund.small_5d < 0) {
      bonus += 3;
      reasons.push('大单净流入、小单净流出，筹码从散户向大资金转移');
    }
    if (stageKey === 'climax' && fund.main_5d < 0) {
      risks.push('高位区主力资金已在流出，风险进一步放大');
    }
  } else {
    risks.push('主力资金数据缺失，资金维度未计分');
  }

  /* 龙虎榜 / 游资 */
  if (bb && bb.count > 0) {
    if (bb.famous.length) {
      bonus += 6;
      reasons.push(`龙虎榜出现公开报道的知名游资席位（${bb.famous.slice(0, 2).join('、')}）`);
    }
    if (bb.institution > 0) {
      bonus += 2;
      reasons.push(`龙虎榜有 ${bb.institution} 个机构专用席位`);
    }
    if (bb.net > 0) {
      bonus += 3;
      reasons.push(`龙虎榜净买入 ${(bb.net / 1e8).toFixed(2)} 亿`);
    } else if (bb.net < 0) {
      risks.push(`龙虎榜净卖出 ${(Math.abs(bb.net) / 1e8).toFixed(2)} 亿`);
      bonus -= 4;
    }
    reasons.push(`近 30 日上榜 ${bb.days} 次（最近 ${bb.last_date ?? '—'}）`);
  } else if (bb) {
    reasons.push('近 30 日无龙虎榜记录（未被大资金重点进攻）');
  }

  /* 跨年特征（历史统计口径） */
  const cy = [];
  if (isNum(f.float_cap_yi) && f.float_cap_yi <= 35) { bonus += 4; cy.push(`市值 ${f.float_cap_yi} 亿，低于 2024 年跨年强势股中位数（34 亿）`); }
  else if (isNum(f.float_cap_yi) && f.float_cap_yi <= 60) { bonus += 2; cy.push(`市值 ${f.float_cap_yi} 亿，接近跨年强势股上限`); }
  else if (isNum(f.float_cap_yi)) { cy.push(`市值 ${f.float_cap_yi} 亿，高于跨年强势股常见区间`); }

  if (isNum(f.price) && f.price <= 10) { bonus += 3; cy.push(`股价 ${f.price} 元，符合低价特征`); }
  else if (isNum(f.price) && f.price <= 17) { bonus += 1; cy.push(`股价 ${f.price} 元，接近 2024 年中位（16.65 元）`); }

  if (isNum(f.pe) && f.pe > 0 && f.pe <= 24) { bonus += 2; cy.push(`PE ${f.pe} 倍，低于 A 股整体市盈率中位数 24 倍`); }

  if (isNum(f.turnover) && f.turnover >= 9) { cy.push(`换手 ${f.turnover}%，高于跨年强势股活跃度参考值（月均 9% 为月度口径，日换手需结合观察）`); }

  if (cy.length) reasons.push('跨年特征：' + cy.join('；'));

  return { bonus, reasons, risks };
}

/* ══════════ 扩展画像：概念 / 筹码 / 杠杆 / 解禁 ══════════ */

/** 热门概念关键词（用于判断是否踩在风口上） */
export const HOT_CONCEPT_WORDS = [
  '机器人', '人形机器人', '人工智能', 'AI', '算力', '芯片', '半导体', '存储', '光模块',
  '光伏', '储能', '固态电池', '锂电池', '钠离子', '氢能', '核电', '可控核聚变',
  '低空经济', '商业航天', '卫星', '军工', '创新药', '减肥药', '合成生物',
  '数据要素', '信创', '华为', '鸿蒙', '量子', '脑机接口', '6G', '可控核聚变',
  '国企改革', '并购重组', '次新股', '高送转', '并购重组',
];

/**
 * 取单只股票的扩展画像（4 个请求并发）
 * @returns {{concepts:string[], concept_count:number, hot_concepts:string[],
 *            holder_change_pct:number|null, holder_num:number|null,
 *            margin_balance:number|null, margin_change_pct:number|null,
 *            unlock_90d_count:number, unlock_90d_cap:number|null}}
 */
export async function fetchExtraProfile(code) {
  const suc = /^(6|9)/.test(code) ? `${code}.SH` : /^(83|87|88|92|43|82)/.test(code) ? `${code}.BJ` : `${code}.SZ`;
  const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
  const out = {
    concepts: [], concept_count: 0, hot_concepts: [],
    holder_change_pct: null, holder_num: null,
    margin_balance: null, margin_change_pct: null,
    unlock_90d_count: 0, unlock_90d_cap: null,
  };
  async function safe(url) {
    try { return await getJson(url, 8000); } catch { return null; }
  }
  const [themeRes, holderRes, marginRes, liftRes] = await Promise.all([
    safe(`${DC}?reportName=RPT_F10_CORETHEME_BOARDTYPE&columns=ALL&filter=(SECUCODE%3D%22${suc}%22)&pageNumber=1&pageSize=60&source=HSF10&client=PC`),
    safe(`${DC}?reportName=RPT_HOLDERNUMLATEST&columns=ALL&filter=(SECUCODE%3D%22${suc}%22)&pageNumber=1&pageSize=3&sortColumns=END_DATE&sortTypes=-1&source=WEB&client=WEB`),
    safe(`${DC}?reportName=RPTA_WEB_RZRQ_GGMX&columns=ALL&filter=(SCODE%3D%22${code}%22)&pageNumber=1&pageSize=25&sortColumns=DATE&sortTypes=-1&source=WEB&client=WEB`),
    safe(`${DC}?reportName=RPT_LIFT_STAGE&columns=ALL&filter=(SECURITY_CODE%3D%22${code}%22)&pageNumber=1&pageSize=20&sortColumns=FREE_DATE&sortTypes=1&source=WEB&client=WEB`),
  ]);

  // 概念
  const boards = (themeRes?.result?.data ?? []).map((r) => String(r.BOARD_NAME ?? '')).filter(Boolean);
  const uniq = [...new Set(boards)];
  out.concepts = uniq.slice(0, 12);
  out.concept_count = uniq.length;
  out.hot_concepts = uniq.filter((b) => HOT_CONCEPT_WORDS.some((w) => b.includes(w))).slice(0, 6);

  // 股东户数（减少＝筹码集中）
  const hRow = (holderRes?.result?.data ?? [])[0];
  if (hRow && Number.isFinite(Number(hRow.HOLDER_NUM))) {
    out.holder_num = Number(hRow.HOLDER_NUM);
    const ratio = Number(hRow.HOLDER_NUM_RATIO);
    out.holder_change_pct = Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null;
    out.holder_date = String(hRow.END_DATE ?? '').slice(0, 10);
  }

  // 融资余额趋势（近 25 个交易日）
  const mRows = (marginRes?.result?.data ?? []).filter((r) => Number.isFinite(Number(r.RZYE)));
  if (mRows.length >= 2) {
    const latest = Number(mRows[0].RZYE);
    const old = Number(mRows[Math.min(mRows.length - 1, 20)].RZYE);
    out.margin_balance = latest;
    if (old > 0) out.margin_change_pct = Number((((latest - old) / old) * 100).toFixed(2));
    out.margin_date = String(mRows[0].DATE ?? '').slice(0, 10);
  }

  // 未来 90 日解禁
  const now = Date.now();
  const lifts = (liftRes?.result?.data ?? [])
    .map((r) => ({
      date: String(r.FREE_DATE ?? '').slice(0, 10),
      cap: Number(r.LIFT_MARKET_CAP) || 0,
    }))
    .filter((r) => r.date && new Date(r.date).getTime() > now && new Date(r.date).getTime() <= now + 90 * 86400000);
  out.unlock_90d_count = lifts.length;
  out.unlock_90d_cap = lifts.reduce((a, r) => a + r.cap, 0) || null;

  return out;
}

/** 扩展维度的加减分 */
export function scoreExtraProfile(f, extra, stageKey) {
  const reasons = [];
  const risks = [];
  let bonus = 0;
  if (!extra) return { bonus: 0, reasons: ['扩展画像数据缺失'], risks: [] };

  // ① 概念数量与热门赛道
  if (extra.concept_count >= 8) { bonus += 3; reasons.push(`涉及 ${extra.concept_count} 个概念板块，题材覆盖广`); }
  else if (extra.concept_count >= 4) { bonus += 2; reasons.push(`涉及 ${extra.concept_count} 个概念板块`); }
  if (extra.hot_concepts.length) {
    bonus += extra.hot_concepts.length >= 2 ? 6 : 4;
    reasons.push(`踩中热门赛道：${extra.hot_concepts.join('、')}`);
  }

  // ② 股东户数（越降越集中）
  if (extra.holder_change_pct !== null) {
    if (extra.holder_change_pct <= -10) { bonus += 6; reasons.push(`股东户数减少 ${Math.abs(extra.holder_change_pct)}%，筹码大幅集中`); }
    else if (extra.holder_change_pct <= -3) { bonus += 3; reasons.push(`股东户数减少 ${Math.abs(extra.holder_change_pct)}%，筹码趋于集中`); }
    else if (extra.holder_change_pct >= 15) { bonus -= 5; risks.push(`股东户数增加 ${extra.holder_change_pct}%，散户大量涌入，筹码分散`); }
  }

  // ③ 融资余额（杠杆资金）
  if (extra.margin_change_pct !== null) {
    if (extra.margin_change_pct >= 15) { bonus += 4; reasons.push(`融资余额 20 日增加 ${extra.margin_change_pct}%，杠杆资金进场`); }
    else if (extra.margin_change_pct <= -15) { bonus -= 3; risks.push(`融资余额 20 日减少 ${Math.abs(extra.margin_change_pct)}%，杠杆资金撤离`); }
  }

  // ④ 解禁压力
  if (extra.unlock_90d_count > 0) {
    if (extra.unlock_90d_cap && isNum(f.float_cap_yi) && extra.unlock_90d_cap / 1e8 >= f.float_cap_yi * 0.08) {
      bonus -= 6;
      risks.push(`未来 90 日有 ${extra.unlock_90d_count} 批解禁（约 ${(extra.unlock_90d_cap / 1e8).toFixed(1)} 亿），超过流通市值 8%，抛压大`);
    } else {
      bonus -= 2;
      risks.push(`未来 90 日有 ${extra.unlock_90d_count} 批解禁`);
    }
  }

  // ⑤ 高位区 + 解禁/户数放大 = 更危险
  if (stageKey === 'climax' && (extra.holder_change_pct ?? 0) >= 15) {
    risks.push('高位区叠加股东户数大增，典型的散户接盘结构');
  }

  return { bonus, reasons, risks };
}

/* ══════════ 相对强度：逆势与抗跌 ══════════ */

/** 取上证指数日线，用于计算个股相对强度 */
export async function fetchIndexKline(lmt = 130) {
  try {
    const j = await getJson(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001` +
      `&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${lmt}`,
      8000,
    );
    return (j?.data?.klines ?? []).map((l) => {
      const p = l.split(',');
      return { date: p[0], close: +p[2] };
    }).filter((b) => Number.isFinite(b.close) && b.close > 0);
  } catch { return []; }
}

/**
 * 相对强度：把个股日线与上证对齐，算
 *   - 近 20 日超额收益（个股涨幅 − 大盘涨幅）
 *   - 大盘单日跌幅 >1% 的日子里，个股的平均涨跌（抗跌性）
 *   - 这些日子里跑赢大盘的比例
 */
export function computeRelativeStrength(bars, indexBars) {
  if (!bars?.length || !indexBars?.length) return null;
  const idxMap = new Map(indexBars.map((b, i) => [b.date, i]));
  const pairs = [];
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].date;
    const j = idxMap.get(d);
    if (j == null || j < 1) continue;
    const sRet = (bars[i].close / bars[i - 1].close - 1) * 100;
    const iRet = (indexBars[j].close / indexBars[j - 1].close - 1) * 100;
    if (!Number.isFinite(sRet) || !Number.isFinite(iRet)) continue;
    pairs.push({ sRet, iRet });
  }
  if (pairs.length < 25) return null;
  const last = pairs.slice(-20);
  const sum = (arr, k) => arr.reduce((a, p) => a + p[k], 0);
  const excess20 = sum(last, 'sRet') - sum(last, 'iRet');
  const down = pairs.filter((p) => p.iRet < -1);
  const downAvg = down.length ? sum(down, 'sRet') / down.length : null;
  const downBeat = down.length ? down.filter((p) => p.sRet > p.iRet).length / down.length : null;
  const up = pairs.filter((p) => p.iRet > 1);
  const upAvg = up.length ? sum(up, 'sRet') / up.length : null;
  return {
    excess_20d: Number(excess20.toFixed(1)),
    down_days: down.length,
    down_avg: downAvg === null ? null : Number(downAvg.toFixed(2)),
    down_beat_ratio: downBeat === null ? null : Number((downBeat * 100).toFixed(0)),
    up_avg: upAvg === null ? null : Number(upAvg.toFixed(2)),
    aligned_days: pairs.length,
  };
}

/* ══════════ 妖股潜质（强度）与跨年妖候选（日历+特征）两个独立概念 ══════════ */

/**
 * 妖股潜质分数：衡量「它现在有多强、有没有资格继续被资金做」
 * 与阶段无关，高位也可以分很高——强度是事实，风险另算。
 *
 * 组成（合计 100）：
 *   相对强度 35：超额收益、抗跌、逆势跑赢比例
 *   资金与游资 25：主力净流入、龙虎榜、知名席位
 *   活跃度与基因 20：涨停次数、最大连板、换手
 *   趋势与位置 20：均线多头、突破、涨幅
 */
export function scorePotential(f, rs, fund, bb) {
  const reasons = [];
  const risks = [];
  let score = 0;

  // ① 相对强度（35）
  if (rs) {
    if (rs.excess_20d >= 30) { score += 20; reasons.push(`近 20 日跑赢上证 ${rs.excess_20d} 个百分点，极强`); }
    else if (rs.excess_20d >= 15) { score += 14; reasons.push(`近 20 日超额收益 +${rs.excess_20d}pp`); }
    else if (rs.excess_20d >= 5) { score += 8; reasons.push(`近 20 日小幅跑赢大盘 +${rs.excess_20d}pp`); }
    else if (rs.excess_20d < -5) { score -= 4; risks.push(`近 20 日跑输上证 ${Math.abs(rs.excess_20d)}pp`); }
    if (rs.down_avg !== null) {
      if (rs.down_avg > 0) { score += 10; reasons.push(`大盘跌超1%的 ${rs.down_days} 天里，它平均还涨 ${rs.down_avg}%，逆势`); }
      else if (rs.down_avg > -2) { score += 6; reasons.push(`大盘跌超1%的 ${rs.down_days} 天里平均仅跌 ${Math.abs(rs.down_avg)}%，抗跌`); }
      else { risks.push(`大盘跌超1%时平均跌 ${Math.abs(rs.down_avg)}%，跟随大盘`); }
    }
    if (rs.down_beat_ratio !== null && rs.down_beat_ratio >= 60) { score += 5; reasons.push(`下跌日跑赢大盘比例 ${rs.down_beat_ratio}%`); }
  } else {
    risks.push('相对强度数据不足（新股或停牌较多）');
  }

  // ② 资金与游资（25）
  if (fund) {
    if (fund.main_5d > 0 && fund.main_20d > 0) { score += 10; reasons.push(`主力 5 日 +${(fund.main_5d / 1e8).toFixed(2)} 亿、20 日 +${(fund.main_20d / 1e8).toFixed(2)} 亿，持续流入`); }
    else if (fund.main_5d > 0) { score += 5; reasons.push(`主力近 5 日转为净流入`); }
    else if (fund.main_5d < 0) { risks.push(`主力近 5 日净流出 ${(Math.abs(fund.main_5d) / 1e8).toFixed(2)} 亿`); }
    if (fund.inflow_streak >= 3) { score += 4; reasons.push(`连续 ${fund.inflow_streak} 日净流入`); }
    if (fund.super_5d + fund.large_5d > 0 && fund.small_5d < 0) { score += 3; reasons.push('大单进、小单出，筹码向大资金集中'); }
  }
  if (bb && bb.count > 0) {
    if (bb.famous?.length) { score += 6; reasons.push(`龙虎榜有公开报道的知名游资席位（${bb.famous.slice(0, 2).join('、')}）`); }
    if (bb.net > 0) { score += 3; reasons.push(`龙虎榜净买入 ${(bb.net / 1e8).toFixed(2)} 亿`); }
    if (bb.days >= 3) { score += 3; reasons.push(`近 30 日上榜 ${bb.days} 次，资金反复参与`); }
  }

  // ③ 活跃度与涨停基因（20）
  if (f.limit_ups_90d >= 10) { score += 10; reasons.push(`近 90 日涨停 ${f.limit_ups_90d} 次，涨停基因强`); }
  else if (f.limit_ups_90d >= 5) { score += 6; reasons.push(`近 90 日涨停 ${f.limit_ups_90d} 次`); }
  else if (f.limit_ups_90d <= 1) { score += 2; }
  if (f.max_consecutive_90d >= 4) { score += 6; reasons.push(`曾走出 ${f.max_consecutive_90d} 连板`); }
  else if (f.max_consecutive_90d >= 2) { score += 3; }
  if (f.turnover !== null && f.turnover >= 5) { score += 4; reasons.push(`换手 ${f.turnover}%，流动性足`); }

  // ④ 趋势与位置（20）
  if (f.bull_align) { score += 8; reasons.push('均线完全多头'); }
  if (f.breakout) { score += 6; reasons.push('价格站上 60 日平台'); }
  if ((f.ret60 ?? 0) >= 50) { score += 6; reasons.push(`60 日涨幅 ${f.ret60}%`); }

  // 风险单列（不扣潜质分，只做提示）
  if (f.pos120 >= 94) risks.push(`位置 ${f.pos120}%，已在区间顶部，追高风险大`);
  if ((f.ret60 ?? 0) >= 150) risks.push(`60 日涨幅 ${f.ret60}%，涨幅巨大`);

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, risks };
}

/**
 * 跨年妖候选资格：日历窗口 + 历史统计五特征
 * 与「阶段」无关——高位也可以是跨年妖（历史上很多跨年妖在主升段才被发现），
 * 但高位要明确标注风险。
 */
/* ══════════ 跨年妖：规则来自多渠道公开文章的共识 ══════════ */

/**
 * 规则来源：2026-11-09 用 12 组关键词检索，抓取 41 篇正文（东方财富财富号 18、雪球 6、搜狐 4、
 * 股吧 4、新浪 3、叩富网 2、天眼查 / 北京证券 / 网易 / B站 各 1），按「提到该特征的文章占比」排序：
 *   风险退潮 82% · 热门题材 78% · 启动窗口 78% · 小市值 70% · 低价 65% · 业绩 53%
 *   连板高度 46% · 游资 46% · 市场情绪 39% · 筹码干净 34% · 重组/控制权 31%
 *   换手 29% · 名字辨识度 26% · 低位启动 26%
 * 文中给出的阈值：股价上限中位 7 元（最常见 10 元）；流通市值上限中位 50 亿。
 * 与上一版（证券时报·数据宝统计）的关键差异：
 *   - 估值：网评一致认为跨年妖「业绩往往很差甚至亏损」「脱离业绩的纯题材炒作」，
 *     低 PE 不是特征，原规则把它当加分项是错的 → 删除
 *   - 股价：17 元太宽 → 10 元（低于 7 元为强）
 *   - 新增：启动时间（80% 在 11 月中旬至 12 月初打响第一波）、低位启动、连板基因、
 *     筹码干净（机构持股低）、资本运作催化（重组 / 控制权变更）
 *   - 新增风险项：30 日涨幅接近 200% 监管红线、近 5 日跌停（退潮）
 * 这仍是「画像相似度」：符合不代表会成妖，网评同样有大量「预测落空」的案例。
 */
export const CROSS_YEAR_RULES = {
  sources: { articles: 41, channels: '东方财富财富号、雪球、搜狐、股吧、新浪、叩富网、天眼查、北京证券、网易、B站', date: '2026-11-09' },
  core: [
    { key: 'price', name: '低价', weight: 14, mention: 65, rule: '启动前股价 ≤10 元（≤7 元为强）' },
    { key: 'cap', name: '小市值', weight: 14, mention: 70, rule: '流通市值 ≤50 亿（≤30 亿为强）' },
    { key: 'theme', name: '热门题材', weight: 18, mention: 78, rule: '契合当年主线题材，≥2 个热门概念为强' },
    { key: 'timing', name: '启动时间', weight: 12, mention: 78, rule: '本轮第一个涨停落在 11 月中旬至 12 月初（10 月下旬起算）' },
    { key: 'low', name: '低位启动', weight: 10, mention: 26, rule: '启动前处于近 120 日区间下半部（≤50%）' },
    { key: 'gene', name: '连板基因', weight: 14, mention: 46, rule: '近 90 日出现过 ≥2 连板，或涨停 ≥3 次' },
    { key: 'chips', name: '筹码干净', weight: 8, mention: 34, rule: '基金/QFII/社保/券商/保险合计持股占流通盘 <20%（不含控股股东类法人）' },
    { key: 'catalyst', name: '资本运作催化', weight: 10, mention: 31, rule: '近 6 个月有重组 / 控制权变更 / 股权转让类公告' },
  ],
};

const CATALYST_WORDS = ['重大资产重组', '资产重组', '控制权', '实际控制人变更', '股权转让', '要约收购', '借壳', '发行股份购买资产', '筹划', '战略投资者', '协议转让'];

/** 跨年画像补充数据：机构持股、近 6 个月资本运作公告 */
export async function fetchCrossYearExtra(code) {
  const pre = /^(6|9)/.test(code) ? 'SH' : /^(83|87|88|92|43)/.test(code) ? 'BJ' : 'SZ';
  const out = { org_ratio: null, org_date: null, catalysts: [] };
  try {
    const j = await getJson(`https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=${pre}${code}`, 8000);
    const all = j?.jgcc ?? [];
    const latest = all.length ? String(all[0].REPORT_DATE ?? '').slice(0, 10) : null;
    // 东财「机构合计(00)」包含控股股东类一般法人(07)，不是网评说的机构。
    // 这里只算交易型机构：基金 01、QFII 02、社保 03、券商 04、保险 05、信托 06
    const pro = all.filter((r) => String(r.REPORT_DATE ?? '').slice(0, 10) === latest && ['01', '02', '03', '04', '05', '06'].includes(String(r.ORG_TYPE)));
    if (latest) {
      out.org_ratio = Number(pro.reduce((a, r) => a + (Number(r.TOTAL_SHARES_RATIO) || 0), 0).toFixed(1));
      out.org_date = latest;
    }
  } catch { /* 缺数据就不计这一项 */ }
  try {
    const j = await getJson(`https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=50&page_index=1&ann_type=A&client_source=web&stock_list=${code}`, 8000);
    const since = Date.now() - 183 * 86400000;
    out.catalysts = (j?.data?.list ?? [])
      .filter((x) => new Date(String(x.notice_date).slice(0, 10)).getTime() >= since)
      .filter((x) => CATALYST_WORDS.some((w) => String(x.title).includes(w)))
      .slice(0, 3).map((x) => ({ date: String(x.notice_date).slice(0, 10), title: String(x.title).replace(/^[^:：]*[:：]/, '') }));
  } catch { /* 同上 */ }
  return out;
}

/** 启动日期是否在网评共识的时间窗（10/20 ~ 12/10） */
function inLaunchWindow(dateStr) {
  if (!dateStr) return false;
  const [, m, d] = dateStr.split('-').map(Number);
  return (m === 10 && d >= 20) || m === 11 || (m === 12 && d <= 10);
}

/**
 * @param {object} f      computeFeatures 输出
 * @param {object} profile fetchExtraProfile 输出（热门概念）
 * @param {boolean} windowActive 当前是否在 11 月—次年 1 月
 * @param {object} cyx    fetchCrossYearExtra 输出
 */
export function crossYearEligibility(f, profile, windowActive, cyx = null) {
  if (!windowActive) return { eligible: false, score: 0, hit: 0, total: CROSS_YEAR_RULES.core.length, checks: [], risks: [], note: '当前不在跨年窗口（11 月—次年 1 月）' };
  const checks = [];
  let score = 0, hit = 0;
  const add = (key, pass, strong, detail) => {
    const r = CROSS_YEAR_RULES.core.find((x) => x.key === key);
    const got = pass ? (strong ? r.weight : Math.round(r.weight * 0.6)) : 0;
    if (pass) hit++;
    score += got;
    checks.push({ key: r.name, pass, strong: !!(pass && strong), detail, standard: r.rule, mention: r.mention, got, weight: r.weight });
  };
  // 价格与市值按「启动前」看；还没启动就看现价
  const basePrice = f.launch?.price ?? f.price;
  add('price', isNum(basePrice) && basePrice <= 10, isNum(basePrice) && basePrice <= 7,
    `${f.launch ? '启动前' : '现价'} ${isNum(basePrice) ? basePrice : '—'} 元`);
  const cap = isNum(f.float_cap_yi) && f.launch && f.price ? f.float_cap_yi * (f.launch.price / f.price) : f.float_cap_yi;
  add('cap', isNum(cap) && cap <= 50, isNum(cap) && cap <= 30, `${f.launch ? '启动前' : '当前'}流通 ${isNum(cap) ? cap.toFixed(1) : '—'} 亿`);
  const hot = profile?.hot_concepts ?? [];
  add('theme', hot.length >= 1, hot.length >= 2, hot.slice(0, 3).join('、') || '未命中热门概念');
  add('timing', !!(f.launch && inLaunchWindow(f.launch.date)), false,
    f.launch ? `本轮启动 ${f.launch.date}` : '近 40 日没有启动信号');
  const lowPos = f.launch?.pos_before ?? f.pos120;
  add('low', isNum(lowPos) && lowPos <= 50, isNum(lowPos) && lowPos <= 30, `${f.launch ? '启动前' : '当前'}位于区间 ${isNum(lowPos) ? lowPos : '—'}%`);
  add('gene', (f.max_consecutive_90d ?? 0) >= 2 || (f.limit_ups_90d ?? 0) >= 3, (f.max_consecutive_90d ?? 0) >= 3,
    `近 90 日涨停 ${f.limit_ups_90d ?? 0} 次，最高 ${f.max_consecutive_90d ?? 0} 连板`);
  if (cyx && isNum(cyx.org_ratio)) add('chips', cyx.org_ratio < 20, cyx.org_ratio < 5, `交易型机构持股 ${cyx.org_ratio}%（${cyx.org_date}）`);
  else checks.push({ key: '筹码干净', pass: null, detail: '机构持股数据缺失，未计分', standard: CROSS_YEAR_RULES.core.find((x) => x.key === 'chips').rule, got: 0, weight: 0 });
  if (cyx) add('catalyst', cyx.catalysts.length > 0, cyx.catalysts.length > 0,
    cyx.catalysts.length ? cyx.catalysts.map((x) => `${x.date} ${x.title}`).join('；').slice(0, 60) : '近 6 个月无相关公告');

  // 可计分的满分（缺数据的项不进分母，避免误罚）
  const maxScore = checks.reduce((a, c) => a + (c.weight || 0), 0) || 1;
  const pct = Math.round((score / maxScore) * 100);

  // 风险项：不扣画像分，单独提示（网评 82% 的文章强调退潮风险）
  const risks = [];
  if (isNum(f.ret30) && f.ret30 >= 150) risks.push(`近 30 日已涨 ${f.ret30}%，接近 200% 的异常波动监管红线，易被停牌核查或问询`);
  if ((f.limit_down_5d ?? 0) > 0) risks.push(`近 5 日出现 ${f.limit_down_5d} 次跌停，典型退潮信号`);
  if (f.launch && f.launch.gain_since >= 200) risks.push(`启动以来已涨 ${f.launch.gain_since}%，后段接力风险极高`);
  if (isNum(f.from_high) && f.from_high <= -25 && (f.max_consecutive_90d ?? 0) >= 3) risks.push(`距高点已回撤 ${Math.abs(f.from_high)}%，高度板走弱`);

  const core3 = ['低价', '小市值', '热门题材'].every((k) => checks.find((c) => c.key === k)?.pass);
  const eligible = pct >= 55 && core3;
  return {
    eligible, score: pct, hit, total: checks.filter((c) => c.pass !== null).length, checks, risks,
    note: !core3 ? '低价、小市值、热门题材三项核心特征不全，不符合跨年妖画像'
      : pct >= 75 ? `画像相似度 ${pct}%，高度符合网评共识的跨年妖特征`
      : pct >= 55 ? `画像相似度 ${pct}%，具备跨年妖的主要特征`
      : `画像相似度 ${pct}%，特征不足`,
  };
}
