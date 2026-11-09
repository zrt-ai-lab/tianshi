/**
 * 个股体检 · 综合评分与决策引擎
 *
 * 目的：把分散在各维度的数据汇成**一个能拍板的结论**，而不是甩一堆术语。
 *
 * 设计纪律：
 *   1. 每个维度都能从 facts 算出来，算不出来就是 null，不猜
 *   2. 权重固定并公开，不因个股调整（否则就是过拟合）
 *   3. 输出三档决策：可以买 / 再等等 / 别碰 —— 不给第四档模糊答案
 *   4. 结论必须附带「为什么」和「什么时候会变」，否则不可证伪
 *
 * 这是**筛选排序工具**，不是涨跌预测。方向预测已在 VALIDATION.md 中证伪。
 */

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function avg(arr) {
  const a = arr.filter(isNum);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

/** 简单移动平均（末值） */
function maEnd(values, n) {
  if (values.length < n) return null;
  const w = values.slice(-n);
  return w.reduce((a, b) => a + b, 0) / n;
}

/** ATR%（14 日） */
function atrPct(bars, n = 14) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null;
  const w = bars.slice(-(n + 1));
  const trs = [];
  for (let i = 1; i < w.length; i++) {
    const c = w[i];
    const p = w[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const last = bars[bars.length - 1].close;
  return last ? (atr / last) * 100 : null;
}

/** 维度定义：权重合计 100，权重写死 */
export const DIMENSIONS = [
  { key: 'valuation', name: '估值', weight: 25, hint: 'PE 历史分位，越低越好' },
  { key: 'quality', name: '盈利质量', weight: 25, hint: 'ROE / 毛利率 / 负债率' },
  { key: 'growth', name: '成长', weight: 15, hint: '营收与净利同比' },
  { key: 'capital', name: '资金', weight: 20, hint: '近 5/20 日主力净流入' },
  { key: 'trend', name: '趋势', weight: 15, hint: '价格与均线位置' },
];

/**
 * @returns {{total:number|null, dims:Array, coverage:number, verdict:string, headline:string, reasons:string[], risks:string[], plan:object, caveats:string[]}}
 */
export function computeDecision(facts, card, stage, longterm = null) {
  const v = facts.valuation_pct ?? null;
  const fin = facts.financials ?? null;
  const ff = facts.fund_flow ?? null;
  const bars = Array.isArray(facts.kline_daily) ? facts.kline_daily : [];
  const q = facts.quote ?? null;
  const risk = card?.risk ?? null;
  const price = q?.price ?? (bars.length ? bars[bars.length - 1].close : null);
  const closes = bars.map((b) => b.close);
  const ma20 = maEnd(closes, 20);
  const ma60 = maEnd(closes, 60);
  const atr = atrPct(bars);
  const caveats = [];

  /* ── 逐维度打分（0-100，null = 无数据，不参与加权） ── */
  const dims = [];

  // 1) 估值：PE 分位越低分越高
  let valuation = null;
  if (isNum(v?.pe_ttm_pct)) {
    valuation = clamp(100 - v.pe_ttm_pct);
  } else caveats.push('缺估值历史分位，估值维度未计分');
  dims.push({ key: 'valuation', name: '估值', weight: 25, score: valuation,
    detail: isNum(v?.pe_ttm_pct) ? `PE 分位 ${v.pe_ttm_pct}%` : '无数据' });

  // 2) 盈利质量：ROE(年化) 40% + 毛利率 30% + 负债率 30%
  let quality = null;
  if (fin) {
    const roeScore = isNum(fin.roe) ? clamp((fin.roe / 25) * 100) : null;
    const gmScore = isNum(fin.gross_margin) ? clamp((fin.gross_margin / 50) * 100) : null;
    const debtScore = isNum(fin.debt_ratio) ? clamp(100 - fin.debt_ratio) : null;
    quality = avg([roeScore, gmScore, debtScore]);
    if (quality === null) caveats.push('财务字段不足，盈利质量维度未计分');
  } else caveats.push('无财务数据，盈利质量维度未计分');
  dims.push({ key: 'quality', name: '盈利质量', weight: 25, score: quality,
    detail: fin ? `ROE ${isNum(fin.roe) ? fin.roe + '%' : '—'} · 毛利 ${isNum(fin.gross_margin) ? fin.gross_margin.toFixed(0) + '%' : '—'}` : '无数据' });

  // 3) 成长：增速为主，但叠加绝对盈利能力修正
  //
  // 原写法只看同比：营收 -5% 直接掉到 40 分，一家 ROE 30%、净利率 20% 的
  // 优质公司会因为行业周期营收微降被重罚，这不合理。
  // 现在：增速分（权重 70%）+ 绝对盈利质量（ROE 权重 30%）做修正。
  let growth = null;
  if (fin) {
    const rev = isNum(fin.revenue_yoy) ? clamp(50 + fin.revenue_yoy * 2) : null;
    const np = isNum(fin.netprofit_yoy) ? clamp(50 + fin.netprofit_yoy * 2) : null;
    const growthByRate = avg([rev, np]);
    // 绝对盈利能力：ROE 25% 记满分，0% 记 0 分
    const absQuality = isNum(fin.roe) ? clamp((fin.roe / 25) * 100) : null;
    growth = growthByRate === null ? null
      : absQuality === null ? growthByRate
      : growthByRate * 0.7 + absQuality * 0.3;
  }
  if (growth === null) caveats.push('缺同比增速，成长维度未计分');
  dims.push({ key: 'growth', name: '成长', weight: 15, score: growth,
    detail: fin ? `营收 ${isNum(fin.revenue_yoy) ? (fin.revenue_yoy > 0 ? '+' : '') + fin.revenue_yoy.toFixed(1) + '%' : '—'} · 净利 ${isNum(fin.netprofit_yoy) ? (fin.netprofit_yoy > 0 ? '+' : '') + fin.netprofit_yoy.toFixed(1) + '%' : '—'}` : '无数据' });

  // 4) 资金：主力净流入占「同期成交额总额」的比例
  //
  // 原写法用 日均成交额 做分母再乘 500 倍，系数是拍的、没有标定过程。
  // 改为份额口径：net / 同期成交额合计。这个比例有天然上下界（主力不可能
  // 净买超过全部成交），可直接解释——净流入占同期成交 5% 就是很强的承接。
  let capital = null;
  let capital_share = null;
  if (ff && bars.length >= 20) {
    const recent20 = bars.slice(-20);
    const total20 = recent20.reduce((a, b) => a + (isNum(b.amount) ? b.amount : 0), 0);
    const total5 = recent20.slice(-5).reduce((a, b) => a + (isNum(b.amount) ? b.amount : 0), 0);
    // 比例 → 分数：0% 记 50 分；±10% 映射到 0/100，线性且可解释
    const shareScore = (net, turn) =>
      (isNum(net) && isNum(turn) && turn > 0 ? clamp(50 + (net / turn) * 500) : null);
    const s5 = shareScore(ff.main_net_5d, total5);
    const s20 = shareScore(ff.main_net_20d, total20);
    capital = avg([s5, s20]);
    if (isNum(ff.main_net_20d) && total20 > 0) {
      capital_share = Number(((ff.main_net_20d / total20) * 100).toFixed(2));
    }
  }
  if (capital === null) caveats.push('资金流数据不足，资金维度未计分');
  dims.push({ key: 'capital', name: '资金', weight: 20, score: capital,
    detail: ff ? `近5日 ${isNum(ff.main_net_5d) ? ((ff.main_net_5d >= 0 ? '+' : '') + (ff.main_net_5d / 1e8).toFixed(2) + '亿') : '—'} · 20日 ${isNum(ff.main_net_20d) ? ((ff.main_net_20d >= 0 ? '+' : '') + (ff.main_net_20d / 1e8).toFixed(2) + '亿') : '—'}`
      + (capital_share !== null ? `（占同期成交 ${capital_share > 0 ? '+' : ''}${capital_share}%）` : '') : '无数据' });

  // 5) 趋势：站上 MA20 +30、站上 MA60 +40、MA20>MA60 +30
  let trend = null;
  if (isNum(price) && ma20 !== null && ma60 !== null) {
    let t = 0;
    if (price > ma20) t += 30;
    if (price > ma60) t += 40;
    if (ma20 > ma60) t += 30;
    trend = clamp(t);
  }
  if (trend === null) caveats.push('K 线不足，趋势维度未计分');
  dims.push({ key: 'trend', name: '趋势', weight: 15, score: trend,
    detail: (isNum(price) && ma20 !== null && ma60 !== null) ? `价${price > ma20 ? '>' : '<'}MA20${ma20 > ma60 ? ' · MA20>MA60' : ' · MA20<MA60'}` : '无数据' });

  /* ── 加权汇总：只对「有分且有数据」的维度按权重归一 ── */
  const scored = dims.filter((d) => isNum(d.score));
  const wSum = scored.reduce((a, d) => a + d.weight, 0);
  const total = wSum > 0 ? Math.round(scored.reduce((a, d) => a + d.score * d.weight, 0) / wSum) : null;
  const coverage = Math.round((scored.length / dims.length) * 100);
  if (coverage < 100) caveats.push(`仅 ${scored.length}/${dims.length} 个维度有数据（覆盖率 ${coverage}%），总分代表性下降`);
  // 覆盖率过低时总分会膨胀（只剩强势维度在加权），标记为不可用于横比
  const total_reliable = coverage >= 60;
  if (!total_reliable) caveats.push(`覆盖率仅 ${coverage}%（<60%），总分只反映少数维度，不能用于横向比较`);

  /* ── 风险闸门：高风险直接降档 ── */
  const level = isNum(risk?.level) ? risk.level : null;
  const cap = isNum(risk?.position_cap_pct) ? risk.position_cap_pct : null;

  /* ── 决策：区分「趋势坏了不能买」和「涨多了不能追」 ── */
  const stageKey = stage?.stage?.key ?? null;
  const badStage = stageKey && ['broken', 'ebb', 'divergence'].includes(stageKey);
  const closesForRet = (Array.isArray(facts.kline_daily) ? facts.kline_daily : []).map((b) => b.close);
  const nRet = closesForRet.length;
  const ret5 = nRet > 5 ? ((closesForRet[nRet - 1] - closesForRet[nRet - 6]) / closesForRet[nRet - 6]) * 100 : null;
  const ret20 = nRet > 20 ? ((closesForRet[nRet - 1] - closesForRet[nRet - 21]) / closesForRet[nRet - 21]) * 100 : null;
  const rising = (ret5 !== null && ret5 > 3) || (ret20 !== null && ret20 > 8);
  const riseText = ret5 !== null && Math.abs(ret5) >= 0.5
    ? `近 5 日${ret5 > 0 ? '涨' : '跌'} ${Math.abs(ret5).toFixed(1)}%`
    : ret20 !== null ? `近 20 日${ret20 > 0 ? '涨' : '跌'} ${Math.abs(ret20).toFixed(1)}%` : '';

  let verdict = 'unknown';
  let label = '数据不足';
  let headline = '';
  let stance = '';
  let whyNot = '';

  if (badStage) {
    verdict = 'avoid';
    if (stageKey === 'divergence') {
      label = '别追高';
      headline = `它${riseText || '近期在涨'}，但高位出现放量回落——这种位置买进去，是在接别人的筹码`;
      whyNot = '涨得多不等于能买。高位放量下跌通常是资金在派发，不是洗盘';
    } else {
      label = '先别买';
      headline = `趋势已经走坏——${stage.evidence?.[0] ?? '股价跌破关键均线'}`;
      whyNot = '趋势没修复之前，反弹也只当反弹看，不追';
    }
    stance = stage.stage.do + '；等它重新站上关键均线、缩量企稳再考虑';
  } else if (total === null) {
    verdict = 'unknown';
    label = '数据不足';
    headline = '关键数据缺失，无法给出结论';
    stance = '先把数据补齐，不要凭感觉下手';
  } else if (level !== null && (level >= 5 || cap === 0)) {
    verdict = 'avoid';
    label = '风险过高';
    const trg = Array.isArray(risk?.triggers) && risk.triggers.length ? risk.triggers : [];
    const ddEst = risk?.drawdown_est ?? null;
    headline = trg.length
      ? `被风控一票否决——${trg.join('；')}`
      : '被风控一票否决：关键闸门没有通过';
    whyNot = (cap === 0
      ? `R${level} 对应的可承受仓位上限是 0，也就是这个风险级别下不该持有`
      : `R${level} 对应的可承受仓位只有 ${cap}%`) +
      (ddEst ? `；同级历史回撤区间约 ${ddEst}` : '') +
      '。不是判断它一定会跌，是它的波动超出了能承受的范围';
    stance = cap === 0
      ? '不碰。等风险降级后再重新评估。'
      : '仓位上限过低，暂不参与';
  } else if (total >= 70 && (level === null || level <= 3)) {
    verdict = 'buy';
    label = '可以考虑';
    headline = rising
      ? `综合 ${total} 分，风险 R${level}，${riseText}——趋势和基本面都不错，可以找回调买，不必追高`
      : `综合 ${total} 分，风险 R${level}，位置也不高，可以考虑建仓`;
    // 建仓建议同样要说明「凭什么」——否则用户只能看到一个分数
    const strongDim = scored.slice().sort((a, b) => b.score - a.score)[0];
    whyNot = rising
      ? `它已经涨了（${riseText}），但支撑这个分数的是「${strongDim?.name ?? '综合面'}」` +
        `${strongDim?.detail ? `（${strongDim.detail}）` : ''}，不是单纯的价格惯性`
      : `分数高来自「${strongDim?.name ?? '综合面'}」${strongDim?.detail ? `（${strongDim.detail}）` : ''}` +
        '，且当前位置不极端，风险在可承受范围内';
    stance = '分批建仓，先上计划仓位的一半，跌了再补';
  } else if (total < 55) {
    const worst = scored.slice().sort((a, b) => a.score - b.score)[0];
    const isCompounder = longterm && ['compounder', 'high_yield'].includes(longterm.style?.key) && (longterm.score ?? 0) >= 60;
    if (isCompounder) {
      // 长牛票不能用短线资金流一票否决：它的逻辑是分红与现金流
      verdict = 'wait';
      label = '长线可拿，等位置';
      headline = `五维只有 ${total} 分，短板是「${worst?.name ?? '资金'}」——但它是「${longterm.style.name}」，这类票本来就不看短期资金`;
      whyNot = '短线确实不是买点，但长线逻辑没坏。关键区别：你想赚差价，还是想收分红吃复利';
      stance = '想长线拿就分批、越跌越买；想赚短线就别选这种慢票，它涨得慢、磨得住人';
    } else {
      verdict = 'avoid';
      label = '先别买';
      headline = `综合只有 ${total} 分，短板在「${worst?.name ?? '多个维度'}」——${worst?.detail || '这项明显拖后腿'}`;
      whyNot = '分数低不代表马上跌，只代表现在买它的性价比不高';
      stance = '先放自选观察，等短板修复再考虑';
    }
  } else {
    verdict = 'wait';
    label = '再等等';
    headline = `综合 ${total} 分，不差但也没便宜，风险 R${level}` +
      (rising ? `，${riseText}——不是坏票，只是现在不是好价格` : '——等更好的位置或更强的信号');
    // 「再等等」也必须有理由，否则用户不知道在等什么
    const weakDim = scored.slice().sort((a, b) => a.score - b.score)[0];
    const gap = 70 - total;
    whyNot = weakDim
      ? `差 ${gap} 分到可建仓线，主要拖累是「${weakDim.name}」` +
        `${weakDim.detail ? `（${weakDim.detail}）` : ''}` +
        (rising ? '；而且已经涨了一段，追进去等于用差的价格买好的东西' : '；位置和分数都没到值得出手的程度')
      : `差 ${gap} 分到可建仓线，把短板补上再考虑`;
    stance = longterm && ['compounder', 'high_yield'].includes(longterm.style?.key)
      ? '这类票适合越跌越买、分批拿；但别在放量拉升那天追，等它缩量回踩'
      : '不着急，把买点定下来挂单等回调，追着买容易买在阶段高点';
  }

  /* ── 为什么（取最高分与最低分维度） ── */
  const sorted = scored.slice().sort((a, b) => b.score - a.score);
  const reasons = [];
  const risks = [];
  if (stage?.stage) {
    const key = stage.stage.key === 'limit_chain' || stage.stage.key === 'first_board' ? 'reasons' : 'risks';
    const line = `阶段：${stage.stage.name} —— ${stage.stage.do}`;
    if (key === 'reasons') reasons.push(line); else risks.push(line);
  }
  if (sorted.length) {
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    reasons.push(`${best.name}最强：${best.detail || dimHint(best.key)}`);
    if (sorted.length > 1) reasons.push(`${sorted[1].name} ${Math.round(sorted[1].score)} 分`);
    if (worst.score < 55) risks.push(`${worst.name}相对最弱：${worst.detail || dimHint(worst.key)}`);
    if (sorted.length > 1 && sorted[sorted.length - 2].score < 55) {
      const w2 = sorted[sorted.length - 2];
      risks.push(`${w2.name}偏弱：${w2.detail || dimHint(w2.key)}`);
    }
  }
  if (fin && isNum(fin.netprofit_yoy) && fin.netprofit_yoy < 0) risks.push(`净利同比 ${fin.netprofit_yoy.toFixed(1)}%，在下滑`);
  if (ff && isNum(ff.main_net_5d) && ff.main_net_5d < 0) risks.push(`近 5 日主力净流出 ${(Math.abs(ff.main_net_5d) / 1e8).toFixed(2)} 亿`);
  if (level !== null && level >= 4) risks.push(`风险等级 R${level}，历史同级别回撤中位数约 ${riskMd(level)}`);

  /* ── 可执行参数 ── */
  const plan = buildPlan({ price, atr, ma20, ma60, level, cap, bars, v });

  return {
    // 规则引擎的原始结论：即使上层用 AI 文案覆盖展示，也要能追溯
    rule_verdict: verdict,
    rule_label: label,
    total,
    total_reliable,
    dims,
    coverage,
    capital_share,
    verdict,
    label,
    stance,
    why_not: whyNot,
    momentum: { ret5, ret20, rising },
    long_term_hint: longterm?.style ? { key: longterm.style.key, name: longterm.style.name, score: longterm.score } : null,
    risk_detail: {
      level,
      position_cap_pct: cap,
      stop_loss_pct: isNum(risk?.stop_loss_pct) ? risk.stop_loss_pct : null,
      drawdown_est: risk?.drawdown_est ?? null,
      triggers: Array.isArray(risk?.triggers) ? risk.triggers : [],
    },
    headline,
    reasons: reasons.slice(0, 3),
    risks: risks.slice(0, 3),
    plan,
    caveats,
    note: '评分是横向筛选工具，用于排序与解释，不是涨跌预测。',
  };
}

function dimHint(key) {
  return {
    valuation: 'PE 分位低',
    quality: 'ROE/毛利/负债',
    growth: '营收与净利增速',
    capital: '主力资金流向',
    trend: '均线位置',
  }[key] ?? '';
}

function riskMd(level) {
  const map = { 1: '-2.5%', 2: '-4.5%', 3: '-9.7%', 4: '-9.8%', 5: '-14.6%' };
  return map[level] ?? '—';
}

/**
 * 执行参数：买入区间 / 仓位 / 止损 / 目标
 * 全部基于可观测的技术位与风控表，不做价格预测。
 */
function buildPlan({ price, atr, ma20, ma60, level, cap, bars, v }) {
  const plan = { buy_zone: null, position_pct: cap, stop_loss_pct: null, target: null, target_basis: null };
  if (!isNum(price)) return plan;

  // 买入区间：优先用均线夹出的区间，否则用 ATR 回撤
  if (ma20 !== null && ma60 !== null && ma60 <= price) {
    const lo = Number(Math.min(ma60, price * 0.97).toFixed(2));
    const hi = Number(Math.min(price, Math.max(ma20, price * 0.99)).toFixed(2));
    plan.buy_zone = [Math.min(lo, hi), Math.max(lo, hi)];
    plan.zone_basis = 'MA60 支撑 ~ MA20 附近';
  } else if (isNum(atr)) {
    plan.buy_zone = [Number((price * (1 - (atr * 2) / 100)).toFixed(2)), Number(price.toFixed(2))];
    plan.zone_basis = `现价下方 2×ATR（${atr.toFixed(2)}%）`;
  }

  // 止损：距现价 2×ATR，且不超过风控表止损
  if (isNum(atr)) {
    const atrStop = -(Math.max(2, Math.min(atr * 2, 12)));
    const tableStop = isNum(level) ? { 1: -12, 2: -10, 3: -8, 4: -6, 5: null }[level] : null;
    const stop = tableStop === null ? atrStop : Math.max(atrStop, tableStop);
    plan.stop_loss_pct = Number(stop.toFixed(1));
  }

  // 目标：近 250 日高点与 MA60 上方空间二选一，明确标注依据
  if (bars.length >= 60) {
    const hi250 = Math.max(...bars.slice(-250).map((b) => b.high));
    const upToHigh = ((hi250 - price) / price) * 100;
    if (upToHigh > 5 && upToHigh <= 40) {
      plan.target = Number(hi250.toFixed(2));
      plan.target_basis = `近 ${Math.min(250, bars.length)} 日最高价`;
      plan.target_upside_pct = Number(upToHigh.toFixed(1));
    } else if (upToHigh > 40) {
      plan.target = Number((price * 1.25).toFixed(2));
      plan.target_basis = '距前高过远，按 +25% 中性目标';
      plan.target_upside_pct = 25;
    } else {
      plan.target = Number((price * 1.15).toFixed(2));
      plan.target_basis = '已接近历史高点，按 +15% 中性目标';
      plan.target_upside_pct = 15;
    }
  }
  return plan;
}
