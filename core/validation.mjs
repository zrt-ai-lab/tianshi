/**
 * 天市 · 实证验证登记簿
 *
 * 这个文件记录的是**测出来的事实**，不是设计意图。
 * 任何结论进入七政卡之前，必须能在这里找到对应的验证状态：
 *   passed   —— 样本外验证通过，可以对外声称
 *   failed   —— 样本外验证失败，禁止对外声称，且必须在报告里警示
 *   untested —— 还没测，不得当作已知
 *
 * 更新方式：重跑 scripts/signals.mjs 与 scripts/basket.mjs，把新数字填进来。
 * 禁止手改数字，禁止在没有新回测的情况下把 failed 改成 passed。
 */

export const VALIDATION_META = {
  measured_at: '2026-11-09',
  basket: ['600519', '000001', '300750', '688981', '601398', '000858', '002594', '600036', '601899', '000333', '002415', '600276', '601012', '600030', '000651'],
  window: '2024-01-01 ~ 2026-11-09',
  cards: 2069,
  train_window: '2015-01-01 ~ 2024-01-01',
  test_window: '2024-01-01 ~ 2026-11-09',
};

/**
 * 方向预测验证：**未通过**。
 * 三个周期的方向命中率全部低于 50%，且「看多时平均收益」不高于「看空时」。
 * 结论：不得在七政卡里给出方向性买入建议。
 */
export const DIRECTIONAL = {
  status: 'failed',
  claim: '方向预测没有可用的样本外信息量',
  by_horizon: {
    short: { calls: 426, hit_rate: 0.38, avg_ret_up_call: 0.45, avg_ret_down_call: 0.44 },
    mid: { calls: 668, hit_rate: 0.415, avg_ret_up_call: 3.33, avg_ret_down_call: 6.55 },
    long: { calls: 545, hit_rate: 0.459, avg_ret_up_call: 17.06, avg_ret_down_call: 17.78 },
  },
  note: '测试集命中率低于 50%，中线「看多时平均收益」反而低于「看空时」（-3.22pp）。',
};

/**
 * 单信号验证：27 组「信号 × 周期」里仅 1 组双集过 52%，
 * 在 27 次独立测试下属随机水平（多重检验），不予采用。
 */
export const SIGNAL_LAB = {
  status: 'failed',
  tested_combinations: 27,
  passed_both_splits: 1,
  passed_detail: 'RSI极值/短线5日：训练 52.3%、测试 53.5%（n=988）；27 次测试里出现 1 次属随机，不采用',
};

/**
 * 风险分级验证：**通过**。
 * 风险等级与实际最大回撤单调对应，且区分度大（R5 约为 R1 的 6 倍）。
 */
export const RISK_GRADING = {
  status: 'passed',
  claim: '风险等级与实际最大回撤单调对应',
  by_level: {
    1: { n: 30, median_max_dd: -2.49 },
    2: { n: 67, median_max_dd: -4.54 },
    3: { n: 3638, median_max_dd: -9.69 },
    4: { n: 1161, median_max_dd: -9.8 },
    5: { n: 366, median_max_dd: -14.61 },
  },
  note: 'R3 与 R4 的回撤中位数接近（-9.69% vs -9.80%），这两级的区分度弱于其它档位，使用时需注意。',
};

/** 拿某个能力的验证状态；未知能力一律 untested，不得对外声称。 */
export function validationOf(capability) {
  const map = { direction: DIRECTIONAL, signal: SIGNAL_LAB, risk: RISK_GRADING };
  return map[capability] ?? { status: 'untested', claim: `${capability} 尚未验证` };
}

/** 方向预测是否可对外使用 */
export function directionalUsable() {
  return DIRECTIONAL.status === 'passed';
}
