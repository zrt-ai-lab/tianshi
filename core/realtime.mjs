/**
 * 实时盘面分析 + 可执行路径
 *
 * 产品纠偏：只说「当前不适合买」没有信息量。
 * 正确的是给出**在什么条件下、什么价位、做什么动作能赚**——
 * 并把「现在不能买」拆成「短线不能追 / 中线等回踩 / 长线等分红率」等具体路径。
 *
 * 数据来源与口径：
 *   - 逐笔成交：腾讯 stock.gtimg.cn（含每笔手数、金额、B/S/M 方向）
 *   - 量比：腾讯行情字段
 *   - 分时量能：东财 trends2
 *   - 板块动量：东财板块 K 线
 *   - 赔率用「到目标价距离 / 到止损价距离」，不编造胜率
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function marketPrefix(code) {
  const c = String(code ?? '');
  if (/^(6|9)/.test(c)) return 'sh';
  if (/^(83|87|88|92|43|82|4)/.test(c)) return 'bj';
  return 'sz';
}

async function text(url, referer = 'https://quote.eastmoney.com/') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: referer } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
  } finally { clearTimeout(timer); }
}

/* ── 逐笔成交：单数分析 ── */
export async function fetchTicks(code, pages = 3) {
  const sym = `${marketPrefix(code)}${code}`;
  const rows = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const raw = await text(`https://stock.gtimg.cn/data/index.php?appn=detail&action=data&c=${sym}&p=${p}`, 'https://gu.qq.com/');
      const m = raw.match(/=\[1,"([^"]*)"\]/);
      if (!m) continue;
      for (const seg of m[1].split('|')) {
        const parts = seg.split('/');
        if (parts.length < 7) continue;
        const lots = Number(parts[4]);
        const amount = Number(parts[5]);
        if (!Number.isFinite(lots) || !Number.isFinite(amount)) continue;
        rows.push({
          time: parts[1], price: Number(parts[2]),
          lots, amount,
          side: parts[6] === 'B' ? 'buy' : parts[6] === 'S' ? 'sell' : 'mid',
        });
      }
    } catch { /* 单页失败不影响整体 */ }
  }
  if (!rows.length) return null;

  const totalLots = rows.reduce((a, r) => a + r.lots, 0);
  const totalAmount = rows.reduce((a, r) => a + r.amount, 0);
  const n = rows.length;
  const buyAmt = rows.filter((r) => r.side === 'buy').reduce((a, r) => a + r.amount, 0);
  const sellAmt = rows.filter((r) => r.side === 'sell').reduce((a, r) => a + r.amount, 0);

  // 大单阈值：单笔金额 >= 100 万
  const BIG = 1e6;
  const bigRows = rows.filter((r) => r.amount >= BIG);
  const bigBuy = bigRows.filter((r) => r.side === 'buy').reduce((a, r) => a + r.amount, 0);
  const bigSell = bigRows.filter((r) => r.side === 'sell').reduce((a, r) => a + r.amount, 0);
  // 超大单：>= 500 万
  const hugeRows = rows.filter((r) => r.amount >= 5e6);

  return {
    samples: n,
    span: rows.length ? `${rows[0].time} ~ ${rows[rows.length - 1].time}` : null,
    total_lots: totalLots,
    total_amount: totalAmount,
    avg_lots: Number((totalLots / n).toFixed(1)),
    avg_amount: Math.round(totalAmount / n),
    buy_amount: buyAmt, sell_amount: sellAmt,
    net_active: buyAmt - sellAmt,                      // 主动买卖净额（逐笔口径）
    buy_ratio: totalAmount ? Number((buyAmt / totalAmount * 100).toFixed(1)) : null,
    big_count: bigRows.length,
    big_amount: bigRows.reduce((a, r) => a + r.amount, 0),
    big_net: bigBuy - bigSell,
    big_buy_ratio: bigRows.length ? Number((bigBuy / (bigBuy + bigSell || 1) * 100).toFixed(1)) : null,
    huge_count: hugeRows.length,
    huge_amount: hugeRows.reduce((a, r) => a + r.amount, 0),
    note: `按最近 ${n} 笔成交统计（单页约 60 笔，最多取 ${pages} 页）`,
  };
}

/* ── 开盘强度（竞价代理） ── */
export function openStrength(minutes, preClose) {
  const pts = (minutes ?? []).filter((p) => isNum(p.close));
  if (!pts.length || !isNum(preClose) || preClose <= 0) return null;
  const first = pts[0];
  const gapPct = ((first.close - preClose) / preClose) * 100;
  // 首 5 分钟量占比
  const firstN = Math.min(5, pts.length);
  const earlyVol = pts.slice(0, firstN).reduce((a, p) => a + (p.volume || 0), 0);
  const totalVol = pts.reduce((a, p) => a + (p.volume || 0), 0);
  const earlyPct = totalVol ? (earlyVol / totalVol) * 100 : null;
  return {
    gap_pct: Number(gapPct.toFixed(2)),
    gap_type: gapPct > 1 ? '高开' : gapPct < -1 ? '低开' : '平开',
    first5_vol_pct: earlyPct === null ? null : Number(earlyPct.toFixed(1)),
    note: '集合竞价明细公开接口不单独提供，这里用开盘跳空幅度 + 首 5 分钟量能占比代理',
  };
}

/* ── 板块动量 ── */
export async function sectorMomentum(sectorCode, sectorName = null) {
  if (!sectorCode) return null;
  try {
    const raw = await text(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.${encodeURIComponent(sectorCode)}` +
      `&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=25`,
    );
    const j = JSON.parse(raw);
    const kl = j?.data?.klines ?? [];
    if (kl.length < 6) return null;
    const closes = kl.map((l) => Number(l.split(',')[2]));
    const last = closes[closes.length - 1];
    const ret = (k) => (closes.length > k ? ((last - closes[closes.length - 1 - k]) / closes[closes.length - 1 - k]) * 100 : null);
    const r5 = ret(5);
    const r20 = ret(20);
    return {
      name: sectorName ?? j?.data?.name ?? null,
      ret_5d: r5 === null ? null : Number(r5.toFixed(2)),
      ret_20d: r20 === null ? null : Number(r20.toFixed(2)),
      momentum: r5 === null ? 'unknown' : r5 > 3 ? '加速' : r5 > 0 ? '温和上行' : r5 > -3 ? '震荡' : '走弱',
    };
  } catch { return null; }
}

/* ── 可执行路径：在什么条件下做什么能赚 ── */
export function buildPathways(ctx) {
  const { price, atrPct, ma20, ma60, pePct, stageKey, longtermKey, volRatio, sector } = ctx;
  const out = [];
  const p = isNum(price) ? price : null;
  const atr = isNum(atrPct) ? atrPct : 3;
  if (p === null) return out;

  const up = (pct) => Number((p * (1 + pct / 100)).toFixed(2));
  const down = (pct) => Number((p * (1 - pct / 100)).toFixed(2));
  const rr = (entry, stop, target) => {
    if (!isNum(entry) || !isNum(stop) || !isNum(target)) return null;
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    return risk > 0 ? Number((reward / risk).toFixed(2)) : null;
  };

  /* ① 短线：突破 / 低吸 */
  const breakout = ma20 ? Number((ma20 * 1.01).toFixed(2)) : up(atr * 0.5);
  const pullback = ma20 ? Number((ma20 * 0.985).toFixed(2)) : down(atr);
  // 止损/目标都**相对进场价**计算，且限制在现实区间，避免赔率虚高
  const clampPct = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const from = (base, pct) => Number((base * (1 + pct / 100)).toFixed(2));
  const entryShort = stageKey === 'broken' ? null : pullback;
  const shortRiskPct = clampPct(atr * 1.0, 2.5, 5);
  const shortRewardPct = clampPct(atr * 1.8, 4, 9);
  const shortStop = entryShort === null ? null : from(entryShort, -shortRiskPct);
  const shortTarget = entryShort === null ? null : from(entryShort, shortRewardPct);
  out.push({
    horizon: '短线',
    window: '1-5 个交易日',
    title: stageKey === 'broken' ? '先修复再谈短线' : '放量突破或回踩不破才动手',
    condition: stageKey === 'broken'
      ? `需要先站回 MA60（约 ${ma60 ? ma60.toFixed(2) : '—'}）并缩量企稳，否则反弹都是逃命机会`
      : `放量（量比 >1.2）站上 ${breakout}，或回踩 ${pullback} 不破且缩量`,
    entry: entryShort,
    breakout_level: stageKey === 'broken' ? null : breakout,
    stop: shortStop,
    target: shortTarget,
    rr: entryShort === null ? null : rr(entryShort, shortStop, shortTarget),
    why: 'A股短线赚的是情绪与资金的钱，量价不配合时做短线等于赌博',
  });

  /* ② 中线：估值 + 趋势修复 */
  const midEntry = ma60 ? Number((ma60 * 0.99).toFixed(2)) : down(atr * 2);
  const midRiskPct = clampPct(atr * 2.2, 6, 10);
  const midRewardPct = clampPct(atr * 4.0, 12, 22);
  const midStop = from(midEntry, -midRiskPct);
  const midTarget = from(midEntry, midRewardPct);
  out.push({
    horizon: '中线',
    window: '1-3 个月',
    title: isNum(pePct) && pePct > 70 ? '等估值或价格回归' : '趋势站稳后分批',
    condition: (isNum(pePct) ? `PE 分位从 ${pePct}% 回落到 60% 以下` : '—') +
      (ma60 ? `，或价格回到 MA60（${ma60.toFixed(2)}）附近不破` : ''),
    entry: midEntry,
    stop: midStop,
    target: midTarget,
    rr: rr(midEntry, midStop, midTarget),
    why: '中线赚的是业绩与估值修复的钱，买贵了就要用时间还',
  });

  /* ③ 长线：收息 / 复利 */
  if (longtermKey === 'compounder' || longtermKey === 'high_yield') {
    out.push({
      horizon: '长线',
      window: '1 年以上',
      title: '按股息率分批，越跌越买',
      condition: `把「跌了才买」当纪律：股价每跌 ${Math.max(3, Math.round(atr))}% 加一档，不看单日涨跌`,
      entry: null,
      stop: null,
      target: null,
      rr: null,
      why: '长线赚的是分红与企业复利的钱，前提是买得足够便宜并拿得住',
    });
  } else if (isNum(pePct) && pePct < 40) {
    out.push({
      horizon: '长线',
      window: '1 年以上',
      title: '估值已在低位，可小仓位尝试',
      condition: `PE 分位 ${pePct}% 处于低位，若 ROE 稳定可分批`,
      entry: null, stop: null, target: null, rr: null,
      why: '长线需要企业质量支撑，不是所有便宜货都值得拿',
    });
  }

  const best = out.filter((x) => isNum(x.rr)).sort((a, b) => b.rr - a.rr)[0];
  return {
    pathways: out,
    best_rr: best ? { horizon: best.horizon, rr: best.rr } : null,
    note: '赔率 = 到目标价的距离 ÷ 到止损价的距离；赔率 ≠ 胜率，也不是收益承诺',
  };
}
