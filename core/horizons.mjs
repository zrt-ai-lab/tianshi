/**
 * 短 / 中 / 长 三周期视图
 *
 * 定位纠正：不预测涨跌，只回答三个问题
 *   1. 这个周期该看什么（关键指标）
 *   2. 当前读数是什么（真实数据）
 *   3. 什么信号出现说明判断要变（转变条件）
 *
 * 这样才能落地，同时不假装能预测价格。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 资金结构拆解：超大单/大单 vs 中小单 */
export function capitalStructure(ff) {
  if (!ff) return null;
  const superNet = isNum(ff.super_net) ? ff.super_net : null;
  const largeNet = isNum(ff.large_net) ? ff.large_net : null;
  const mediumNet = isNum(ff.medium_net) ? ff.medium_net : null;
  const smallNet = isNum(ff.small_net) ? ff.small_net : null;
  const bigMoney = superNet !== null && largeNet !== null ? superNet + largeNet : null;
  const retail = smallNet !== null && mediumNet !== null ? smallNet + mediumNet : null;

  let pattern = 'unknown';
  let meaning = '';
  if (bigMoney !== null && retail !== null) {
    if (bigMoney > 0 && retail < 0) {
      pattern = 'accumulate';
      meaning = '大资金净流入、散户净流出——典型吸筹/主力接货结构';
    } else if (bigMoney < 0 && retail > 0) {
      pattern = 'distribute';
      meaning = '大资金净流出、散户净流入——典型派发/出货结构';
    } else if (bigMoney > 0 && retail > 0) {
      pattern = 'inflow';
      meaning = '大小资金同向流入，情绪一致偏多';
    } else if (bigMoney < 0 && retail < 0) {
      pattern = 'outflow';
      meaning = '大小资金同向流出，情绪一致偏空';
    } else {
      pattern = 'neutral';
      meaning = '资金结构无明显方向';
    }
  }
  return {
    super_net: superNet,
    large_net: largeNet,
    medium_net: mediumNet,
    small_net: smallNet,
    big_money_net: bigMoney,
    retail_net: retail,
    pattern,
    meaning,
  };
}

/** 均线状态 */
function maState(closes) {
  const maEnd = (n) => (closes.length < n ? null : closes.slice(-n).reduce((a, b) => a + b, 0) / n);
  const last = closes.at(-1);
  const ma5 = maEnd(5);
  const ma20 = maEnd(20);
  const ma60 = maEnd(60);
  const ma120 = maEnd(120);
  return {
    last,
    ma5,
    ma20,
    ma60,
    ma120,
    above_ma20: ma20 !== null ? last > ma20 : null,
    above_ma60: ma60 !== null ? last > ma60 : null,
    ma20_above_ma60: ma20 !== null && ma60 !== null ? ma20 > ma60 : null,
  };
}

/**
 * @param {object} facts
 * @param {object} card 七政卡（含 risk / gates）
 * @param {object|null} stage stockStage 结果
 * @param {object|null} cycle marketCycle 结果
 * @param {object|null} company fetchCompany 结果（可缺）
 * @returns {{short:object, mid:object, long:object}}
 */
export function horizonViews(facts, card, stage, cycle, company) {
  const q = facts.quote ?? {};
  const fin = facts.financials ?? {};
  const val = facts.valuation_pct ?? {};
  const ff = facts.fund_flow ?? {};
  const sec = facts.sector ?? {};
  const bars = Array.isArray(facts.kline_daily) ? facts.kline_daily : [];
  const closes = bars.map((b) => b.close);
  const ma = maState(closes);
  const cap = capitalStructure(ff);

  const out = {};

  /* ── 短线 1-5 日：看情绪与量价，不看估值 ── */
  const shortReads = [];
  if (cycle?.stage) shortReads.push({ name: '市场情绪', value: cycle.stage.name, meaning: cycle.stage.mean });
  if (stage?.stage) shortReads.push({ name: '个股阶段', value: stage.stage.name, meaning: stage.stage.do });
  if (cap) shortReads.push({ name: '资金结构', value: patternLabel(cap.pattern), meaning: cap.meaning });
  if (isNum(ff.main_net_5d)) shortReads.push({
    name: '近5日主力', value: money(ff.main_net_5d),
    meaning: ff.main_net_5d > 0 ? '资金在流入' : '资金在流出',
  });
  if (ma.above_ma20 !== null) shortReads.push({
    name: 'MA20', value: ma.above_ma20 ? '站上' : '跌破',
    meaning: ma.above_ma20 ? '短期趋势未坏' : '短期趋势走弱',
  });
  if (sec.matched) shortReads.push({ name: '板块当日', value: `${sec.name} ${pct(sec.pct_chg)}`, meaning: (sec.pct_chg ?? 0) > 0 ? '板块在赚钱' : '板块在亏钱' });

  const shortChange = [];
  if (stage?.stage) shortChange.push(`个股阶段从「${stage.stage.name}」发生切换（如断板、放量破 MA20、缩量止跌）`);
  shortChange.push('市场情绪周期阶段切换（冰点→修复 / 主升→退潮）');
  shortChange.push('单日主力资金方向反转且持续 2 日以上');

  out.short = {
    window: '1-5 个交易日',
    focus: '情绪周期 + 个股量价阶段 + 短期资金',
    reads: shortReads,
    change_if: shortChange,
    stance: shortStance(stage, cycle, cap),
  };

  /* ── 中线 1-3 月：看估值、资金趋势、行业位置 ── */
  const midReads = [];
  if (isNum(val.pe_ttm_pct)) midReads.push({ name: 'PE 三年分位', value: `${val.pe_ttm_pct}%`, meaning: val.pe_ttm_pct < 30 ? '估值处于低位区' : val.pe_ttm_pct > 70 ? '估值处于高位区' : '估值中性' });
  if (isNum(ff.main_net_20d)) midReads.push({ name: '近20日主力', value: money(ff.main_net_20d), meaning: ff.main_net_20d > 0 ? '中期资金净流入' : '中期资金净流出' });
  if (isNum(fin.revenue_yoy)) midReads.push({ name: '营收同比', value: `${fin.revenue_yoy.toFixed(1)}%`, meaning: fin.revenue_yoy > 10 ? '仍在增长' : fin.revenue_yoy < 0 ? '开始下滑' : '增长放缓' });
  if (isNum(fin.netprofit_yoy)) midReads.push({ name: '净利同比', value: `${fin.netprofit_yoy.toFixed(1)}%`, meaning: fin.netprofit_yoy > 0 ? '利润还在增' : '利润在下滑' });
  if (sec.matched && isNum(sec.rank_of_total)) midReads.push({ name: '行业排名', value: `${sec.rank_of_total}/${sec.total}`, meaning: sec.rank_of_total <= (sec.total ?? 500) * 0.3 ? '板块处于强势前列' : '板块处于中后段' });
  if (ma.ma60 !== null) midReads.push({ name: 'MA60', value: `${ma.ma60.toFixed(2)}`, meaning: ma.above_ma60 ? '中期趋势线之上' : '已跌破中期趋势线' });

  out.mid = {
    window: '1-3 个月',
    focus: '估值分位 + 中期资金 + 业绩趋势 + 行业位置',
    reads: midReads,
    change_if: [
      'PE 分位突破 80%（变贵）或跌破 20%（变便宜）',
      '连续两个报告期营收或净利同比转负',
      '近 20 日主力资金持续净流出且板块排名跌出前 50%',
    ],
    stance: midStance(facts, card),
  };

  /* ── 长线 1 年+：看质量、主营、估值绝对值 ── */
  const longReads = [];
  if (isNum(fin.roe)) longReads.push({ name: 'ROE(年化)', value: `${fin.roe}%`, meaning: fin.roe >= 15 ? '优秀' : fin.roe >= 8 ? '一般' : '偏弱' });
  if (isNum(fin.gross_margin)) longReads.push({ name: '毛利率', value: `${fin.gross_margin.toFixed(1)}%`, meaning: '反映护城河与定价权' });
  if (isNum(fin.debt_ratio)) longReads.push({ name: '负债率', value: `${fin.debt_ratio.toFixed(1)}%`, meaning: fin.debt_ratio < 50 ? '财务稳健' : '杠杆偏高' });
  if (isNum(val.current_pe)) longReads.push({ name: 'PE(TTM)', value: `${val.current_pe.toFixed(1)}`, meaning: '绝对估值，需结合行业与增速看' });
  if (company?.main_business?.by_product?.length) {
    const top = company.main_business.by_product[0];
    longReads.push({ name: '主营构成', value: `${top.item} ${(top.ratio * 100).toFixed(0)}%`, meaning: '收入结构集中度' });
  }
  if (company?.shareholders?.free_top10?.length) {
    const top = company.shareholders.free_top10[0];
    longReads.push({ name: '第一大股东', value: `${top.name} ${top.ratio.toFixed(1)}%`, meaning: '股权结构是否稳定' });
  }
  if (company?.reports?.length) {
    const latest = company.reports[0];
    longReads.push({ name: '最新研报', value: latest.rating || latest.org, meaning: latest.title });
  }

  out.long = {
    window: '1 年以上',
    focus: '盈利能力 + 财务质量 + 主营结构 + 股权结构',
    reads: longReads,
    change_if: [
      'ROE 连续两期下滑或跌破 8%',
      '主营结构发生重大变化（单一大客户/单一产品依赖度变化）',
      '大股东持续减持或股权质押比例抬升（本系统暂未接入质押数据）',
      '毛利率连续下滑超过 3 个百分点',
    ],
    stance: longStance(facts),
  };

  return out;
}

function patternLabel(p) {
  return { accumulate: '大资金吸筹', distribute: '大资金派发', inflow: '同向流入', outflow: '同向流出', neutral: '中性', unknown: '未知' }[p] ?? p;
}
function money(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e8) return `${v > 0 ? '+' : ''}${(v / 1e8).toFixed(2)} 亿`;
  if (a >= 1e4) return `${v > 0 ? '+' : ''}${(v / 1e4).toFixed(2)} 万`;
  return String(Math.round(v));
}
function pct(v) {
  return isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '—';
}

function shortStance(stage, cycle, cap) {
  const bad = stage?.stage && ['broken', 'ebb', 'divergence'].includes(stage.stage.key);
  const cycleBad = cycle?.stage && ['retreat', 'ice'].includes(cycle.stage.key);
  const capBad = cap && cap.pattern === 'distribute';
  if (bad) return '短线不参与：个股阶段已经走坏';
  if (cycleBad) return '短线谨慎：市场情绪不支持追涨';
  if (capBad) return '短线回避：大资金在派发';
  if (stage?.stage && ['limit_chain', 'first_board'].includes(stage.stage.key)) return '短线是情绪票，只适合有纪律的博弈，断板即走';
  return '短线可观察，等量价给出方向';
}

function midStance(facts, card) {
  const val = facts.valuation_pct ?? {};
  const fin = facts.financials ?? {};
  const level = card?.risk?.level;
  if (isNum(val.pe_ttm_pct) && val.pe_ttm_pct > 80) return '中线偏谨慎：估值已在历史高位';
  if (isNum(fin.netprofit_yoy) && fin.netprofit_yoy < 0) return '中线需观察：业绩在下滑';
  if (level !== undefined && level >= 4) return '中线不加仓：风险等级偏高';
  if (isNum(val.pe_ttm_pct) && val.pe_ttm_pct < 30) return '中线相对有利：估值处于低位区';
  return '中线中性：等估值或业绩给出方向';
}

function longStance(facts) {
  const fin = facts.financials ?? {};
  if (!isNum(fin.roe)) return '长线无法判断：缺财务数据';
  if (fin.roe >= 15 && isNum(fin.gross_margin) && fin.gross_margin >= 30) return '长线看基本面成立的，但需确认估值是否已透支';
  if (fin.roe < 8) return '长线不成立：ROE 偏低，不具备长期复利能力';
  return '长线中性：质量一般，需持续跟踪';
}
