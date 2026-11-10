/**
 * 连板梯队 · 妖股潜质 · 跨年窗口分析
 *
 * 数据来源：东方财富涨停池（当日 + 上一交易日对比算晋级率）
 *
 * 诚实边界：
 *   1.「妖股潜质」是基于公开量价特征的相似度打分，不是预测会不会成妖。
 *      历史妖股确实有共同特征（低价、小市值、封板早、封单厚、连板高度），
 *      但同样的特征也可能只是普通连板股。分数高＝更像，不代表会涨。
 *   2.「跨年妖」是市场俗称，指 11 月至次年 1 月出现的连板妖股。
 *      这里只做「是否处于跨年窗口 + 当前梯队特征是否符合历史偏好」，
 *      历史胜率没有可靠公开统计，所以不给概率数字。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const ZT_URL = 'https://push2ex.eastmoney.com/getTopicZTPool';
const UT = '7eea3edcaed734bea9cbfc24409ed989';

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

const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

/** 拉某日涨停池明细（最多 200 条） */
export async function fetchPool(dateStr) {
  try {
    const j = await getJson(
      `${ZT_URL}?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=lbc%3Adesc&date=${dateStr}`,
    );
    const list = j?.data?.pool ?? [];
    return list.map((x) => ({
      code: String(x.c ?? ''),
      name: x.n ?? '',
      industry: typeof x.hybk === 'string' && x.hybk.trim() ? x.hybk.trim() : null,
      price: isNum(x.p) ? Number((x.p / 1000).toFixed(2)) : null,
      pct: isNum(x.zdp) ? x.zdp : null,
      amount: x.amount ?? null,
      float_cap: x.ltsz ?? null,
      turnover: isNum(x.hs) ? x.hs : null,
      boards: Number(x.lbc) || 0,
      first_seal: Number(x.fbt) || null,   // 首次封板时间 HHMMSS
      last_seal: Number(x.lbt) || null,
      seal_fund: Number(x.fund) || 0,      // 封单额（元）
      broken: Number(x.zbc) || 0,          // 炸板次数
    })).filter((x) => /^\d{6}$/.test(x.code));
  } catch {
    return [];
  }
}

/** 上一交易日：用上证指数日线取最近两个交易日 */
export async function previousTradeDate(asof = new Date()) {
  try {
    const j = await getJson(
      'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=6',
    );
    const dates = (j?.data?.klines ?? []).map((l) => l.split(',')[0]).filter(Boolean);
    const today = `${asof.getFullYear()}-${String(asof.getMonth() + 1).padStart(2, '0')}-${String(asof.getDate()).padStart(2, '0')}`;
    const past = dates.filter((d) => d < today);
    return past.length ? past[past.length - 1].replace(/-/g, '') : null;
  } catch {
    return null;
  }
}

const fmtTime = (v) => {
  if (!v) return null;
  const s = String(v).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
};

/**
 * 妖股潜质打分（0-100）
 * 只用量价结构特征。分数高只代表「更像历史上的妖股形态」。
 */
export function scoreMonster(s) {
  const reasons = [];
  let score = 0;

  // ① 连板高度（核心）
  if (s.boards >= 5) { score += 34; reasons.push(`${s.boards} 连板，已是当前高度龙头`); }
  else if (s.boards === 4) { score += 28; reasons.push('4 连板，梯队核心位置'); }
  else if (s.boards === 3) { score += 22; reasons.push('3 连板，进入妖股观察区'); }
  else if (s.boards === 2) { score += 12; reasons.push('2 连板'); }
  else { score += 4; reasons.push('首板，尚未形成高度'); }

  // ② 低价（妖股多从低价起步）
  if (isNum(s.price)) {
    if (s.price <= 6) { score += 14; reasons.push(`股价 ${s.price} 元，低价股`); }
    else if (s.price <= 12) { score += 10; reasons.push(`股价 ${s.price} 元，中低价`); }
    else if (s.price <= 25) { score += 4; reasons.push(`股价 ${s.price} 元`); }
    else { reasons.push(`股价 ${s.price} 元偏高`); }
  }

  // ③ 流通市值（小盘更容易被资金拉动，但也更容易被砸）
  if (isNum(s.float_cap)) {
    const yi = s.float_cap / 1e8;
    if (yi <= 50) { score += 16; reasons.push(`流通市值 ${yi.toFixed(0)} 亿，小盘易拉`); }
    else if (yi <= 120) { score += 10; reasons.push(`流通市值 ${yi.toFixed(0)} 亿`); }
    else if (yi <= 300) { score += 4; reasons.push(`流通市值 ${yi.toFixed(0)} 亿`); }
    else { reasons.push(`流通市值 ${yi.toFixed(0)} 亿偏大，不易连板`); }
  }

  // ④ 封板时间（越早越强）
  if (s.first_seal !== null) {
    if (s.first_seal <= 93000) { score += 16; reasons.push(`${fmtTime(s.first_seal)} 开盘即封，最强形态`); }
    else if (s.first_seal <= 103000) { score += 10; reasons.push(`${fmtTime(s.first_seal)} 早盘封板`); }
    else if (s.first_seal <= 143000) { score += 4; reasons.push(`${fmtTime(s.first_seal)} 盘中封板`); }
    else { reasons.push(`${fmtTime(s.first_seal)} 尾盘封板，最弱`); }
  }

  // ⑤ 封单厚度（相对流通市值）
  if (s.seal_fund > 0 && isNum(s.float_cap) && s.float_cap > 0) {
    const ratio = (s.seal_fund / s.float_cap) * 100;
    if (ratio >= 3) { score += 12; reasons.push(`封单占流通 ${ratio.toFixed(1)}%，封得死`); }
    else if (ratio >= 1) { score += 7; reasons.push(`封单占流通 ${ratio.toFixed(1)}%`); }
    else { reasons.push(`封单占流通仅 ${ratio.toFixed(2)}%，封单偏薄`); }
  }

  // ⑥ 换手率（有换手才走得远，过高说明出货）
  if (isNum(s.turnover)) {
    if (s.turnover >= 5 && s.turnover <= 25) { score += 8; reasons.push(`换手 ${s.turnover.toFixed(1)}%，筹码充分换手`); }
    else if (s.turnover > 40) { score -= 6; reasons.push(`换手 ${s.turnover.toFixed(1)}% 过高，有成交换手嫌疑`); }
    else if (s.turnover < 3) { score -= 3; reasons.push(`换手 ${s.turnover.toFixed(1)}% 偏低，筹码没换`); }
  }

  // ⑦ 炸板（扣分）
  if (s.broken > 0) { score -= Math.min(18, s.broken * 5); reasons.push(`盘中炸板 ${s.broken} 次`); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const tier = score >= 75 ? '高潜质' : score >= 60 ? '可观察' : score >= 45 ? '一般' : '偏弱';
  return { score, tier, reasons };
}

/** 梯队结构 */
export function buildLadder(pool, prevPool = []) {
  const byBoard = new Map();
  for (const s of pool) {
    const b = Math.max(1, s.boards);
    if (!byBoard.has(b)) byBoard.set(b, []);
    byBoard.get(b).push(s);
  }
  const levels = [...byBoard.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([boards, list]) => ({
      boards,
      label: boards === 1 ? '首板' : `${boards} 连板`,
      count: list.length,
      items: list
        .map((s) => ({ ...s, monster: scoreMonster(s) }))
        .sort((a, b) => b.monster.score - a.monster.score)
        .slice(0, 120),
    }));

  // 晋级率：昨日 N 板中有多少今天变成 N+1 板
  const prevByBoard = new Map();
  for (const s of prevPool) {
    const b = Math.max(1, s.boards);
    prevByBoard.set(b, (prevByBoard.get(b) || 0) + 1);
  }
  const todaySet = new Set(pool.map((s) => s.code));
  const promo = [];
  // 从高板到低板排列：首先要看到空间板有没有晋级，其次是中位梯队
  for (const [b, cnt] of [...prevByBoard.entries()].sort((a, b2) => b2[0] - a[0])) {
    const sameCode = prevPool.filter((p) => Math.max(1, p.boards) === b);
    const promoted = sameCode.filter((p) => {
      const t = pool.find((x) => x.code === p.code);
      return t && Math.max(1, t.boards) === b + 1;
    });
    const broken = cnt - promoted.length;
    promo.push({
      from_board: b,
      prev_count: cnt,
      promoted: promoted.length,
      broken,
      rate: cnt ? Number(((promoted.length / cnt) * 100).toFixed(1)) : null,
      promoted_names: promoted.map((x) => x.name),
      broken_names: sameCode.filter((x) => !promoted.some((y) => y.code === x.code)).map((x) => x.name),
    });
  }
  // 空间板（昨日最高板）状态
  const prevMaxBoard = Math.max(0, ...prevPool.map((p) => Math.max(1, p.boards)));
  const spaceRow = promo.find((p) => p.from_board === prevMaxBoard) ?? null;

  const maxBoards = levels.length ? levels[0].boards : 0;
  return {
    total: pool.length,
    max_boards: maxBoards,
    levels,
    promotion: promo,
    space_board: spaceRow ? {
      from: prevMaxBoard, to: prevMaxBoard + 1,
      promoted: spaceRow.promoted, broken: spaceRow.broken, rate: spaceRow.rate,
      names: spaceRow.promoted_names,
    } : null,
    continuity: pool.filter((s) => prevPool.some((p) => p.code === s.code)).length,
    prev_total: prevPool.length,
  };
}

/**
 * 跨年窗口判断
 * 跨年妖：市场俗称，指每年 11 月至次年 1 月出现的连板妖股。
 */
export function crossYearWindow(now = new Date()) {
  const m = now.getMonth() + 1;
  const inWindow = m === 11 || m === 12 || m === 1;
  let phase = null;
  if (m === 11) phase = '窗口开启（11月）';
  else if (m === 12) phase = '窗口主段（12月）';
  else if (m === 1) phase = '窗口尾声（1月）';
  return {
    active: inWindow,
    phase,
    month: m,
    rules: [
      '跨年妖股通常出现在 11 月到次年 1 月，本质是资金在年底业绩空窗期炒预期',
      '常见特征：低价（10 元以下）、小市值（50 亿以内）、题材新、连板高度能到 5 板以上',
      '与市场的关系：大盘越弱、题材越缺，资金越集中在少数强势股上做高度',
      '注意：这是市场经验规则，没有可靠的公开胜率统计，只能作为筛选方向',
    ],
    caution: '历史案例可参考，但不能反过来推「今年一定会有」或「这只一定是」',
  };
}

/** 跨年候选：把窗口内的高连板、低价、小市值票挑出来 */
export function crossYearCandidates(ladder, now = new Date()) {
  const win = crossYearWindow(now);
  if (!win.active) return { window: win, candidates: [] };
  const all = [];
  for (const lv of ladder.levels) {
    for (const s of lv.items) {
      if (lv.boards < 2) continue;
      all.push(s);
    }
  }
  const candidates = all
    .sort((a, b) => b.monster.score - a.monster.score)
    .slice(0, 8)
    .map((s) => ({ ...s, cross_year: true }));
  return { window: win, candidates };
}

/**
 * 晋级率的一句话解读
 * 晋级率 = 昨日 N 板里，今天成功变成 N+1 板的比例。
 * 断板率 = 昨日 N 板里，今天没能晋级（含直接跌）的比例。
 */
export function interpretPromotion(ladder) {
  const promo = ladder?.promotion ?? [];
  if (!promo.length) return '昨日与今日涨停池无法对比，晋级率不可用';
  const space = ladder.space_board;
  const mid = promo.filter((p) => p.from_board >= 2 && p.from_board <= 4);
  const parts = [];

  if (space) {
    parts.push(space.promoted
      ? `空间板 ${space.from}→${space.to} 成功晋级（${space.names.join('、') || '—'}）`
      : `空间板 ${space.from} 板全断（${space.broken} 只未晋级）`);
  }
  if (mid.length) {
    const allZero = mid.every((p) => p.rate === 0);
    const best = mid.slice().sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
    if (allZero) parts.push(`${mid.map((m) => m.from_board).join('/')} 板中位梯队全部断板，接力断层`);
    else parts.push(`中位梯队最高晋级率 ${best.rate}%（${best.from_board}→${best.from_board + 1}）`);
  }
  const low = promo.find((p) => p.from_board === 1);
  if (low) parts.push(`低位 1→2 晋级 ${low.rate}%`);
  return parts.join('；');
}
