/**
 * 天市 · 确定性基线分析
 *
 * 关键设计：**不用模型猜概率**。
 * 每个周期先做「历史状态类比」——在当前指标状态（趋势/动量/MACD 符号）相同的历史时刻，
 * 统计其后续 N 个交易日的真实收益分布，得到基准概率与区间。
 * 样本数、胜率、分位数都是算出来的，可回测；模型只负责解释和加权，不能凭空改概率。
 *
 * 数据不足以做类比时，直接返回 dir="unknown"，禁止编一个方向出来。
 */

import { snapshot, sma, rsi, macd, atr, stateSignature, signatureSeries } from './indicators.mjs';

const HORIZONS = [
  { key: 'short', bars: 5, label: '1-5 交易日' },
  { key: 'mid', bars: 60, label: '1-3 个月' },
  { key: 'long', bars: 250, label: '12 个月' },
];

/** 分位数（线性插值），输入需已排序 */
function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 历史状态类比：找历史上同状态的时刻，统计后续 forwardBars 的真实收益。
 * @returns {{n:number, prob_up:number|null, rets:number[], p10:number|null, p50:number|null, p90:number|null}}
 */
export function historicalAnalog(bars, currentSig, forwardBars, sigs = null) {
  const closes = bars.map((b) => b.close);
  const series = sigs ?? signatureSeries(bars);
  const raw = [];      // 全部匹配点（窗口重叠，仅作参考）
  const indep = [];    // 非重叠独立样本（统计只认这个）
  const allFwd = [];   // 全样本前瞻收益，用于算无条件基准
  let nextFree = -Infinity;

  // 前 61 根用于指标预热，且要留出 forwardBars 的观察窗口
  for (let i = 60; i + forwardBars < closes.length; i++) {
    const a = closes[i];
    const b = closes[i + forwardBars];
    if (!a || !b) continue;
    allFwd.push(((b - a) / a) * 100);
    if (series[i] !== currentSig) continue;
    const r = ((b - a) / a) * 100;
    raw.push(r);
    // 独立样本：两次取样之间至少隔一个完整观察窗口，避免同一波行情被重复计数
    if (i >= nextFree) {
      indep.push(r);
      nextFree = i + forwardBars;
    }
  }

  const use = indep.length >= 3 ? indep : indep.length > 0 ? indep : [];
  if (use.length === 0) {
    return { n: 0, n_raw: raw.length, prob_up: null, rets: [], p10: null, p50: null, p90: null, low_sample: true };
  }
  const sorted = [...use].sort((x, y) => x - y);
  // 无条件基准：这只股票「随机任一天买入后 N 天上涨」的频率。
  // 条件概率只有相对它才有意义 —— 47% 的条件概率在基准 50% 的市场里是负信息。
  const baseRateUp = allFwd.length > 0 ? allFwd.filter((r) => r > 0).length / allFwd.length : null;
  return {
    n: use.length,                 // 独立样本数（进闸门的是这个）
    n_raw: raw.length,             // 重叠匹配数（仅供说明，不参与统计）
    base_rate_up: baseRateUp,
    prob_up: use.filter((r) => r > 0).length / use.length,
    rets: use,
    p10: quantile(sorted, 0.1),
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    low_sample: use.length < 10,
  };
}

function fmtMoney(yuan) {
  if (yuan === null || yuan === undefined) return null;
  const abs = Math.abs(yuan);
  if (abs >= 1e8) return `${(yuan / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(yuan / 1e4).toFixed(2)} 万`;
  return `${yuan.toFixed(0)} 元`;
}

/**
 * 生成三周期基线判断。
 * @param {object} facts gather 的输出
 * @returns {{horizons: object, indicators: object, notes: string[]}}
 */
/**
 * 缺失项 → 受影响维度：**单一真源**在 contract/qizheng.mjs 的 MISSING_DIMENSIONS。
 * analysis 与 validateCard 必须用同一张表，否则回放新增缺失键时会互相打架。
 */
import { MISSING_DIMENSIONS } from './contract/qizheng.mjs';

/** 契约 §5-7：missing 非空时，受影响维度必须在 drivers 里说明「无数据」。
 *  任何返回路径都必须调用它，否则校验会拒卡。 */
function injectMissingDrivers(horizons, facts) {
  const missSet = new Set((facts?.missing ?? []).map(String));
  for (const key of missSet) {
    const dims = Object.hasOwn(MISSING_DIMENSIONS, key) ? MISSING_DIMENSIONS[key] : ['short', 'mid', 'long'];
    for (const dim of dims) {
      const h = horizons?.[dim];
      if (!h) continue;
      h.drivers = Array.isArray(h.drivers) ? h.drivers : [];
      const line = `无数据：${key} 本轮未取到，该维度判断未纳入`;
      if (!h.drivers.includes(line)) h.drivers.push(line);
    }
  }
  return horizons;
}

export function baselineAnalysis(facts) {
  const bars = facts.kline_daily ?? [];
  const notes = [];
  if (bars.length < 61) {
    return {
      horizons: injectMissingDrivers(
        Object.fromEntries(HORIZONS.map((h) => [h.key, unknownHorizon(h, 'K 线不足 61 根，无法做历史类比')])),
        facts,
      ),
      indicators: null,
      notes: ['K 线数据不足，全部维度返回 unknown'],
    };
  }

  const snap = snapshot(bars);
  const sigSeries = signatureSeries(bars);
  const sig = sigSeries[bars.length - 1];
  if (sig === null) {
    return {
      horizons: injectMissingDrivers(
        Object.fromEntries(HORIZONS.map((h) => [h.key, unknownHorizon(h, '指标预热不足')])),
        facts,
      ),
      indicators: snap,
      notes: ['指标预热不足'],
    };
  }

  const price = snap.close;
  const out = {};

  for (const h of HORIZONS) {
    const analog = historicalAnalog(bars, sig, h.bars, sigSeries);
    if (analog.n === 0) {
      out[h.key] = unknownHorizon(h, `历史上没有匹配到同状态样本（签名 ${sig}）`);
      continue;
    }

    const drivers = [];
    drivers.push(`状态签名 ${sig}`);
    drivers.push(`历史同状态独立样本 ${analog.n} 个（重叠匹配 ${analog.n_raw} 个，不计入统计），其后 ${h.bars} 个交易日上涨占 ${(analog.prob_up * 100).toFixed(0)}%`);
    drivers.push(`同状态收益中位数 ${analog.p50.toFixed(2)}%（10%~90% 分位 ${analog.p10.toFixed(1)}%~${analog.p90.toFixed(1)}%）`);
    if (analog.base_rate_up !== null) {
      const e = analog.prob_up - analog.base_rate_up;
      drivers.push(
        `无条件基准上涨率 ${(analog.base_rate_up * 100).toFixed(1)}%，条件概率 ${(analog.prob_up * 100).toFixed(1)}%，超额 ${(e * 100).toFixed(1)}pp`,
      );
    }

    if (h.key === 'short') {
      const ff = facts.fund_flow;
      if (ff?.today_main_net !== null && ff?.today_main_net !== undefined) {
        drivers.push(`当日盘中主力净流入 ${fmtMoney(ff.today_main_net)}（截至 ${ff.today_date}）`);
      }
      if (ff?.main_net_5d !== null && ff?.main_net_5d !== undefined) {
        drivers.push(`近5个交易日主力累计净流入 ${fmtMoney(ff.main_net_5d)}（截至 ${ff.trade_date}）`);
      }
      if (!ff) drivers.push('无数据：资金流缺失，短线判断未纳入资金面');
    }
    if (h.key === 'mid' || h.key === 'long') {
      if (facts.financials) {
        drivers.push(
          `${facts.financials.report_name}：ROE ${fmt(facts.financials.roe)}%，营收同比 ${fmt(facts.financials.revenue_yoy)}%，净利同比 ${fmt(facts.financials.netprofit_yoy)}%`,
        );
      } else {
        drivers.push('无数据：财务数据缺失，中长线判断未纳入基本面');
      }
      if (facts.valuation_pct?.pe_ttm_pct !== null && facts.valuation_pct?.pe_ttm_pct !== undefined) {
        drivers.push(`PE(TTM) ${fmt(facts.valuation_pct.current_pe)} 处于近 ${facts.valuation_pct.window_years} 年 ${facts.valuation_pct.pe_ttm_pct}% 分位`);
      }
    }
    if (h.key === 'long' && facts.sector?.matched) {
      drivers.push(`所属板块 ${facts.sector.name} 当日 ${fmt(facts.sector.pct_chg)}%，板块主力净流入 ${fmtMoney(facts.sector.main_net)}`);
    }

    // 方向 = 条件概率相对无条件基准的超额，而不是绝对概率。
    // 绝对阈值会让「基准 50% 的市场里 47% 的条件概率」被判成震荡，
    // 也会让「基准 30% 的熊股里 35% 的条件概率」被判成震荡 —— 两者含义完全不同。
    const EDGE = 0.05;
    const baseRate = analog.base_rate_up;
    const edge = baseRate === null ? null : analog.prob_up - baseRate;
    const dir =
      analog.n < 10 || edge === null
        ? 'unknown'
        : edge >= EDGE
          ? 'up'
          : edge <= -EDGE
            ? 'down'
            : 'flat';
    const range = [price * (1 + analog.p10 / 100), price * (1 + analog.p90 / 100)].map((x) => Number(x.toFixed(2)));

    // 样本不足时不给概率：6 个样本算出 100% 上行，是统计假象，不是信息。
    const MIN_N_FOR_PROB = 10;
    const probUp = analog.n < MIN_N_FOR_PROB ? null : Number(analog.prob_up.toFixed(3));
    if (probUp === null) {
      drivers.push(`⚠️ 独立样本仅 ${analog.n} 个，不足以给出概率，本周期只给方向不给概率`);
    }
    // 每个周期各自的置信度上限（受本周期样本数限制，而不是全卡共用）
    const confidenceCap = analog.n >= 30 ? 0.9 : analog.n >= 10 ? 0.65 : 0.55;
    // 报出的概率不得超过样本支持的上限：宁可低估自己的把握，也不虚报
    let cappedProb = probUp;
    if (cappedProb !== null && cappedProb > confidenceCap) {
      drivers.push(`样本仅 ${analog.n} 个，把握度被压到上限 ${(confidenceCap * 100).toFixed(0)}%（原始频率 ${(analog.prob_up * 100).toFixed(0)}%）`);
      cappedProb = confidenceCap;
    }

    out[h.key] = {
      dir,
      prob_up: cappedProb,
      confidence_cap: confidenceCap,
      range: h.key === 'long' ? null : range, // 长线区间跨度大，给区间反而误导
      window: h.label,
      invalid_if: makeInvalidIf(h, snap, price, dir, facts),
      drivers,
      sample_n: analog.n,
      sample_n_raw: analog.n_raw,
      base_rate: {
        p10: analog.p10 === null ? null : Number(analog.p10.toFixed(2)),
        p50: analog.p50 === null ? null : Number(analog.p50.toFixed(2)),
        p90: analog.p90 === null ? null : Number(analog.p90.toFixed(2)),
      },
    };
  }

  injectMissingDrivers(out, facts);
  return { horizons: out, indicators: snap, notes, signature: sig };
}

function fmt(v) {
  return v === null || v === undefined ? '无数据' : Number(v).toFixed(2);
}

function unknownHorizon(h, reason) {
  return {
    dir: 'unknown',
    prob_up: null,
    range: null,
    window: h.label,
    invalid_if: `无法给出：${reason}`,
    drivers: [`无数据：${reason}`],
    sample_n: 0,
    base_rate: null,
  };
}

/** 失效条件：用真实价位表述，便于事后验证 */
function makeInvalidIf(h, snap, price, dir, facts) {
  const atr = snap.atr14 ?? price * 0.02;
  if (h.key === 'short') {
    const stop = Number((price - atr * 1.5).toFixed(2));
    return `收盘跌破 ${stop}（现价下方 1.5×ATR）`;
  }
  if (h.key === 'mid') {
    const ma60 = snap.ma60 === null ? null : Number(snap.ma60.toFixed(2));
    if (ma60 !== null) return `月线级别跌破 MA60 = ${ma60}`;
    return `跌破现价下方 15%`;
  }
  const fin = facts.financials;
  if (fin && fin.netprofit_yoy !== null) {
    return `PE 分位升破 90% 或下一期净利同比转负（本期 ${Number(fin.netprofit_yoy).toFixed(1)}%）`;
  }
  return 'PE 分位升破 90% 或营收/净利同比转负';
}

/**
 * 从事实包里**确定性推导**反证（不是让模型自己想）。
 * 每条反证都必须能挂到一个真实证据上，否则不收录。
 */
export function deriveCounterEvidence(facts) {
  const out = [];
  const push = (claim, evidence_id) => {
    if (evidence_id) out.push({ claim, evidence_id });
  };

  const ff = facts.fund_flow;
  if (ff) {
    if (ff.today_main_net !== null && ff.today_main_net !== undefined && ff.today_main_net < 0) {
      push(`当日盘中（截至 ${ff.today_date}）主力净流出 ${fmtMoney(ff.today_main_net)}`, ff.today_evidence_id);
    }
    if (ff.main_net !== null && ff.main_net < 0) {
      push(`上一交易日（${ff.trade_date}）主力净流出 ${fmtMoney(ff.main_net)}`, ff.evidence_id);
    }
    if (ff.main_net_5d !== null && ff.main_net_5d < 0) push(`近5个交易日主力累计净流出 ${fmtMoney(ff.main_net_5d)}`, ff.evidence_id);
    if (ff.main_net_20d !== null && ff.main_net_20d < 0) push(`近20个交易日主力累计净流出 ${fmtMoney(ff.main_net_20d)}`, ff.evidence_id);
  }

  const v = facts.valuation_pct;
  if (v && v.pe_ttm_pct !== null && v.pe_ttm_pct >= 70) {
    push(`PE(TTM) 处于近 ${v.window_years} 年 ${v.pe_ttm_pct}% 分位，进一步抬估值空间有限`, v.evidence_id);
  }
  if (v && v.pb_pct !== null && v.pb_pct >= 85) {
    push(`PB 处于近 ${v.window_years} 年 ${v.pb_pct}% 分位`, v.evidence_id);
  }

  const fin = facts.financials;
  if (fin) {
    if (fin.netprofit_yoy !== null && fin.netprofit_yoy < 0) push(`${fin.report_name} 净利同比 ${Number(fin.netprofit_yoy).toFixed(2)}%，为负`, fin.evidence_id);
    if (fin.revenue_yoy !== null && fin.revenue_yoy < 0) push(`${fin.report_name} 营收同比 ${Number(fin.revenue_yoy).toFixed(2)}%，为负`, fin.evidence_id);
    if (fin.roe !== null && fin.roe < 8) push(`ROE 仅 ${Number(fin.roe).toFixed(2)}%，盈利能力偏弱`, fin.evidence_id);
  }

  if (facts.sector?.matched && facts.sector.main_net !== null && facts.sector.main_net < 0) {
    push(`所属板块「${facts.sector.name}」主力净流出 ${fmtMoney(facts.sector.main_net)}`, facts.sector.evidence_id);
  }

  for (const c of facts.conflicts ?? []) {
    if (c.severity !== 'info') push(`数据源冲突：${c.field} 差异 ${c.delta_pct}%`, null);
  }

  if (Array.isArray(facts.billboard) && facts.billboard.length > 0) {
    const latest = facts.billboard[0];
    if (latest.net_buy !== null && latest.net_buy < 0) push(`最近一次龙虎榜（${latest.trade_date}）净卖出 ${fmtMoney(latest.net_buy)}`, null);
  }

  const snap = facts.kline_daily?.length ? snapshot(facts.kline_daily) : null;
  if (snap && snap.rsi14 !== null && snap.rsi14 >= 70) push(`RSI(14)=${snap.rsi14.toFixed(1)}，处于超买区`, null);
  if (snap && snap.atr_pct !== null && snap.atr_pct >= 4) push(`ATR 占价格 ${snap.atr_pct.toFixed(2)}%，波动剧烈`, null);

  return out;
}

/**
 * 确定性裁决（v0.2：风险驱动，不再由方向驱动）
 *
 * 背景：回测证明方向预测没有样本外信息量（命中率 38%~46%，低于随机）。
 * 既然不能预测方向，就不该拿方向去做「买入」结论 —— 那是把噪声包装成建议。
 *
 * 因此本函数只产出三种结论：
 *   incomplete —— 数据链断裂/逻辑矛盾/反证不足
 *   avoid      —— 风险过高（R5 或仓位上限为 0，或 R4 且估值极端）
 *   watch      —— 其余情况（不提供买入建议，改由「值得考虑的条件清单」给出可执行门槛）
 */
export function decideVerdict(facts, gates, risk) {
  const g = gates ?? {};
  if (g.data?.status === 'fail') return 'incomplete';
  if (g.consistency?.status === 'fail') return 'incomplete';
  if (g.counter?.status === 'fail') return 'incomplete';

  const level = risk?.level ?? 5;
  const cap = risk?.position_cap_pct ?? 0;
  if (cap <= 0 || level >= 5) return 'avoid';

  if (level >= 4) {
    const pe = facts?.valuation_pct?.pe_ttm_pct;
    if (pe !== null && pe !== undefined && pe >= 85) return 'avoid';
    return 'watch';
  }
  return 'watch';
}

/**
 * 「值得考虑的条件」清单：把「什么时候才值得买」变成逐条可核对的硬条件。
 *
 * 这比给一个方向概率有用得多 —— 因为方向概率是噪声，而条件是否满足是可验证的事实。
 * 全部满足才是「可以考虑」，任一条不满足就给出具体缺口。
 */
export function buildBuyConditions(facts, risk) {
  const pe = facts?.valuation_pct?.pe_ttm_pct;
  const roe = facts?.financials?.roe;
  const ff5 = facts?.fund_flow?.main_net_5d;
  const missingSet = new Set((facts?.missing ?? []).map(String));

  const conditions = [
    {
      key: 'risk',
      text: '风险等级 ≤ R2（可承受仓位 ≥ 15%）',
      current: `R${risk?.level ?? '?'} / ${risk?.position_cap_pct ?? '?'}%`,
      met: (risk?.level ?? 9) <= 2 && (risk?.position_cap_pct ?? 0) >= 15,
    },
    {
      key: 'valuation',
      text: 'PE 处于近 3 年 50% 分位以下',
      current: pe === null || pe === undefined ? '无数据' : `${pe}%`,
      met: pe !== null && pe !== undefined && pe < 50,
    },
    {
      key: 'fundflow',
      text: '近 5 个交易日主力资金累计净流入为正',
      current: ff5 === null || ff5 === undefined ? '无数据' : ff5 > 0 ? `净流入 ${(ff5 / 1e8).toFixed(2)} 亿` : `净流出 ${(Math.abs(ff5) / 1e8).toFixed(2)} 亿`,
      met: ff5 !== null && ff5 !== undefined && ff5 > 0,
    },
    {
      key: 'quality',
      text: 'ROE（年化）≥ 10%',
      current: roe === null || roe === undefined ? '无数据' : `${roe}%`,
      met: roe !== null && roe !== undefined && roe >= 10,
    },
    {
      key: 'data',
      text: '关键数据无缺失（行情/K线/财务/资金流）',
      current: ['quote', 'kline_daily', 'financials', 'fund_flow'].filter((k) => missingSet.has(k)).join('、') || '齐全',
      met: ['quote', 'kline_daily', 'financials', 'fund_flow'].every((k) => !missingSet.has(k)),
    },
  ];

  return { conditions, all_met: conditions.every((c) => c.met), met_count: conditions.filter((c) => c.met).length };
}
