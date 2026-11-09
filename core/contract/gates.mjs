/**
 * 五道闸 —— CONTRACT.md §3
 *
 * 纯 ESM，零第三方依赖（Node >= 20）。
 *
 * 实现约定（与契约对齐）：
 *
 * - `GateResult` 严格为 `{ status, detail, blocking }`，不额外挂字段。
 *   契约里的「置信度上限」在 `GateResult` 中没有对应字段，因此单独由
 *   `sampleConfidenceCap()` / `confidenceCap()` 导出，供七政卡与上层使用。
 * - 取不到的字段不参与判定，也不用 0 / 占位符补全（数必有据）。
 * - 判定条目与契约逐条对应，注释里用 ①-1、②-3 这样的编号标注。
 * - 所有阈值均为文件顶部具名常量，便于调参。
 */

import { atrPct, ATR_PERIOD } from './yuzheng.mjs';

/* =============================== 阈值 =============================== */

/* ① 数据闸 */
export const KLINE_MIN_BARS = 60;
export const KLINE_CONFIDENCE_CAP = 0.5;

/* ② 一致性闸 */
export const PRICE_CLOSE_REL_TOL = 0.001; // 相对偏离 0.1%
export const PCT_CHG_ABS_TOL = 0.5; // 百分点差
export const PE_PCT_HIGH = 80; // 与 yuzheng.mjs 的 PE_PCT_HIGH 同义（各自持有，避免循环依赖）
export const ROE_HIGH = 15;
export const ROE_LOW = 8;
export const FUND_PRICE_DIVERGENCE_PCT = -2;

/* ③ 样本闸 */
export const SAMPLE_N_ENOUGH = 30;
export const SAMPLE_N_MIN = 10;
export const SAMPLE_CAP_MID = 0.65; // 10 <= n < 30
export const SAMPLE_CAP_LOW = 0.55; // n < 10
export const SAMPLE_CAP_UNKNOWN = 0.6; // 未提供 sample_n
export const SAMPLE_LOW_LABEL = '低样本';
export const CONFIDENCE_CAP_MAX = 1; // 不受限时的上限

/* ④ 反证闸 */
export const COUNTER_PASS_MIN = 3;
export const COUNTER_WARN_MIN = 1;

/* ⑤ 极端值闸 */
export const EXTREME_PCT_CHG = 9.5; // 涨跌停附近
export const EXTREME_AMPLITUDE = 8;
export const EXTREME_PE_PCT_HIGH = 95;
export const EXTREME_PE_PCT_LOW = 5;
export const EXTREME_ATR_PCT = 5; // 与 yuzheng.mjs 的 ATR_PCT_HIGH 同义（比较符不同：闸用 >=，玉衡用 >）

/* ============================= 小工具 ============================= */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const fmt = (v) => (isNum(v) ? String(Number(v.toFixed(2))) : 'null');

const uniq = (arr) => [...new Set(arr)];

/** GateResult 构造：detail 永远是人可读的一句话 */
function gateResult(status, parts, blocking = []) {
  return {
    status,
    detail: parts.length > 0 ? parts.join('；') : '通过',
    blocking: uniq(blocking),
  };
}

/* ============================== ① 数据闸 ============================== */

function dataGate(facts) {
  const quote = isObj(facts.quote) ? facts.quote : null;
  const kline = Array.isArray(facts.kline_daily) ? facts.kline_daily : [];
  const financials = isObj(facts.financials) ? facts.financials : null;
  const fundFlow = isObj(facts.fund_flow) ? facts.fund_flow : null;

  const reasons = [];
  const blocking = [];
  let fail = false;
  let warn = false;

  // ①-1 quote 缺失 → fail，禁止出任何方向结论
  if (!quote) {
    fail = true;
    blocking.push('quote');
    reasons.push('quote 缺失，禁止输出任何方向结论');
  }

  // ①-2 K 线不足 60 根 → warn（短中线置信度上限 0.5）
  if (kline.length < KLINE_MIN_BARS) {
    warn = true;
    reasons.push(`kline_daily 仅 ${kline.length} 根 < ${KLINE_MIN_BARS}，短中线置信度上限 ${KLINE_CONFIDENCE_CAP}`);
  }

  // ①-3 financials 缺失 → 中线/长线降级
  if (!financials) {
    warn = true;
    blocking.push('mid', 'long');
    reasons.push('financials 缺失，中线/长线降级');
  }

  // ①-4 fund_flow 缺失 → 短线降级
  if (!fundFlow) {
    warn = true;
    blocking.push('short');
    reasons.push('fund_flow 缺失，短线降级');
  }

  if (fail) return gateResult('fail', reasons, blocking);
  if (warn) return gateResult('warn', reasons, blocking);
  return gateResult('pass', [
    `数据齐备：quote + kline ${kline.length} 根 + financials + fund_flow`,
  ]);
}

/* ============================= ② 一致性闸 ============================= */

function consistencyGate(facts) {
  const quote = isObj(facts.quote) ? facts.quote : null;
  const kline = Array.isArray(facts.kline_daily) ? facts.kline_daily : [];
  const valuation = isObj(facts.valuation_pct) ? facts.valuation_pct : null;
  const financials = isObj(facts.financials) ? facts.financials : null;
  const fundFlow = isObj(facts.fund_flow) ? facts.fund_flow : null;

  const fails = [];
  const warns = [];
  const notes = [];
  let status = 'pass';

  const addWarn = (msg) => {
    warns.push(msg);
    if (status !== 'fail') status = 'warn';
  };
  const addFail = (msg) => {
    fails.push(msg);
    status = 'fail';
  };

  const price = quote && isNum(quote.price) ? quote.price : null;
  const prevClose = quote && isNum(quote.prev_close) ? quote.prev_close : null;
  const pctChg = quote && isNum(quote.pct_chg) ? quote.pct_chg : null;
  const lastBar = kline.length > 0 ? kline[kline.length - 1] : null;
  const lastClose = isObj(lastBar) && isNum(lastBar.close) ? lastBar.close : null;

  // ②-1 最新价与最后一根 K 线收盘价偏离 > 0.1%，且处于非交易时段 → warn
  // 契约的 Facts 只有 `is_trading`（是否在交易时段），此处按 `is_trading === false`
  // 视作「非交易时段」；`null` 表示未知，不触发（不猜测）。
  if (price !== null && price > 0 && lastClose !== null && facts.is_trading === false) {
    const dev = Math.abs(price - lastClose) / price;
    if (dev > PRICE_CLOSE_REL_TOL) {
      addWarn(
        `最新价 ${fmt(price)} 与最后一根 K 线收盘 ${fmt(lastClose)} 偏离 ${(dev * 100).toFixed(2)}% > ${(
          PRICE_CLOSE_REL_TOL * 100
        ).toFixed(1)}%（非交易时段，疑似数据未同步）`,
      );
    }
  }

  // ②-2 quote.pct_chg 与 (price/prev_close - 1)*100 差 > 0.5 个百分点 → warn
  if (pctChg !== null && price !== null && prevClose !== null && prevClose > 0) {
    const derived = (price / prevClose - 1) * 100;
    const diff = Math.abs(pctChg - derived);
    if (diff > PCT_CHG_ABS_TOL) {
      addWarn(
        `quote.pct_chg ${fmt(pctChg)} 与 price/prev_close 推导 ${fmt(derived)} 相差 ${fmt(diff)} 个百分点 > ${PCT_CHG_ABS_TOL}`,
      );
    }
  }

  // ②-3 PE 分位 > 80：ROE > 15 → 合理（pass）；ROE < 8 → fail（贵且不赚钱）
  const pePct = valuation && isNum(valuation.pe_ttm_pct) ? valuation.pe_ttm_pct : null;
  const roe = financials && isNum(financials.roe) ? financials.roe : null;
  if (pePct !== null && pePct > PE_PCT_HIGH && roe !== null) {
    if (roe > ROE_HIGH) {
      notes.push(`PE 分位 ${fmt(pePct)} > ${PE_PCT_HIGH} 但 ROE ${fmt(roe)} > ${ROE_HIGH}，高估值有盈利支撑`);
    } else if (roe < ROE_LOW) {
      addFail(`PE 分位 ${fmt(pePct)} > ${PE_PCT_HIGH} 且 ROE ${fmt(roe)} < ${ROE_LOW}：贵且不赚钱，禁止出「买入」方向`);
    }
    // ROE 落在 [8, 15]：契约未定义，不构成 fail/warn（已在上层报告中标注为歧义）
  }

  // ②-4 主力净流入 > 0 但涨跌幅 < -2% → warn（资金与价格背离，必须写进反证）
  const mainNet = fundFlow && isNum(fundFlow.main_net) ? fundFlow.main_net : null;
  if (mainNet !== null && mainNet > 0 && pctChg !== null && pctChg < FUND_PRICE_DIVERGENCE_PCT) {
    addWarn(
      `主力净流入 ${fmt(mainNet)} 元但涨跌幅 ${fmt(pctChg)}% < ${FUND_PRICE_DIVERGENCE_PCT}%，资金与价格背离，必须写进反证`,
    );
  }

  const parts = [...fails, ...warns, ...notes];
  return gateResult(status, parts, []);
}

/* ============================== ③ 样本闸 ============================== */

function sampleGate(ctx) {
  const sample = ctx.sample_n;

  if (!isNum(sample)) {
    // ③-4 未提供 sample_n → warn，置信度上限 0.6
    return gateResult('warn', [`sample_n 未提供，置信度上限 ${SAMPLE_CAP_UNKNOWN}`], []);
  }
  if (sample >= SAMPLE_N_ENOUGH) {
    // ③-1
    return gateResult('pass', [`样本 n=${fmt(sample)} ≥ ${SAMPLE_N_ENOUGH}，置信度不受样本限制`], []);
  }
  if (sample >= SAMPLE_N_MIN) {
    // ③-2
    return gateResult(
      'warn',
      [`样本 n=${fmt(sample)} 落在 [${SAMPLE_N_MIN}, ${SAMPLE_N_ENOUGH})，置信度上限 ${SAMPLE_CAP_MID}`],
      [],
    );
  }
  // ③-3
  return gateResult(
    'warn',
    [`${SAMPLE_LOW_LABEL}：n=${fmt(sample)} < ${SAMPLE_N_MIN}，置信度上限 ${SAMPLE_CAP_LOW}，必须标注「${SAMPLE_LOW_LABEL}」`],
    [],
  );
}

/* ============================== ④ 反证闸 ============================== */

function counterGate(ctx) {
  const list = Array.isArray(ctx.counter_evidence) ? ctx.counter_evidence : [];
  const n = list.length;

  if (n >= COUNTER_PASS_MIN) {
    // ④-1
    return gateResult('pass', [`反证 ${n} 条 ≥ ${COUNTER_PASS_MIN}`], []);
  }
  if (n >= COUNTER_WARN_MIN) {
    // ④-2
    return gateResult('warn', [`反证仅 ${n} 条 < ${COUNTER_PASS_MIN}，置信度降级`], []);
  }
  // ④-3 反证为空 → fail，禁止输出终局判断
  return gateResult('fail', ['反证 0 条，禁止输出终局判断，只能输出「分析未完成」'], ['verdict']);
}

/* ============================= ⑤ 极端值闸 ============================= */

function extremeGate(facts) {
  const quote = isObj(facts.quote) ? facts.quote : null;
  const valuation = isObj(facts.valuation_pct) ? facts.valuation_pct : null;
  const atr = atrPct(facts.kline_daily, ATR_PERIOD);

  const reasons = [];

  // ⑤-1 涨跌停附近 → warn，附带「已异动」
  if (quote && isNum(quote.pct_chg) && Math.abs(quote.pct_chg) >= EXTREME_PCT_CHG) {
    reasons.push(`涨跌幅 ${fmt(quote.pct_chg)}%，已异动（|pct_chg| ≥ ${EXTREME_PCT_CHG}）`);
  }

  // ⑤-2 振幅 >= 8
  if (quote && isNum(quote.amplitude) && quote.amplitude >= EXTREME_AMPLITUDE) {
    reasons.push(`振幅 ${fmt(quote.amplitude)}% ≥ ${EXTREME_AMPLITUDE}`);
  }

  // ⑤-3 PE 分位处于两端 → warn，强制加尾部风险
  if (
    valuation &&
    isNum(valuation.pe_ttm_pct) &&
    (valuation.pe_ttm_pct >= EXTREME_PE_PCT_HIGH || valuation.pe_ttm_pct <= EXTREME_PE_PCT_LOW)
  ) {
    reasons.push(
      `PE 分位 ${fmt(valuation.pe_ttm_pct)} 处于尾部（≥ ${EXTREME_PE_PCT_HIGH} 或 ≤ ${EXTREME_PE_PCT_LOW}），强制加尾部风险`,
    );
  }

  // ⑤-4 ATR% >= 5 → warn（剧烈波动）
  if (isNum(atr) && atr >= EXTREME_ATR_PCT) {
    reasons.push(`ATR% ${fmt(atr)} ≥ ${EXTREME_ATR_PCT}，剧烈波动`);
  }

  return gateResult(reasons.length > 0 ? 'warn' : 'pass', reasons.length > 0 ? reasons : ['无极端值信号'], []);
}

/* ============================== 置信度上限 ============================== */

/**
 * 样本闸给出的置信度上限（契约 §3 ③）。
 * 契约没有为 GateResult 定义 cap 字段，因此以独立函数导出。
 * @param {{ sample_n?: number }} [ctx]
 * @returns {number} 0.55 / 0.6 / 0.65 / 1
 */
export function sampleConfidenceCap(ctx) {
  const sample = isObj(ctx) ? ctx.sample_n : undefined;
  if (!isNum(sample)) return SAMPLE_CAP_UNKNOWN;
  if (sample >= SAMPLE_N_ENOUGH) return CONFIDENCE_CAP_MAX;
  if (sample >= SAMPLE_N_MIN) return SAMPLE_CAP_MID;
  return SAMPLE_CAP_LOW;
}

/**
 * 综合数据闸（K 线 < 60 → 0.5）与样本闸的置信度上限。
 * 其他闸门只做状态判定，契约未赋予额外的 cap。
 * @param {object} facts
 * @param {{ sample_n?: number }} [ctx]
 * @returns {number}
 */
export function confidenceCap(facts, ctx) {
  const kline = Array.isArray(facts?.kline_daily) ? facts.kline_daily : [];
  const klineCap = kline.length < KLINE_MIN_BARS ? KLINE_CONFIDENCE_CAP : CONFIDENCE_CAP_MAX;
  return Math.min(sampleConfidenceCap(ctx), klineCap);
}

/* ================================ 入口 ================================ */

/**
 * 跑五道闸。
 * @param {object} facts Facts（CONTRACT.md §2）
 * @param {{ counter_evidence?: {claim: string, evidence_id: string|null}[], sample_n?: number }} [ctx]
 * @returns {{data: object, consistency: object, sample: object, counter: object, extreme: object}}
 */
export function runGates(facts, ctx) {
  const f = isObj(facts) ? facts : {};
  const c = isObj(ctx) ? ctx : {};

  return {
    data: dataGate(f),
    consistency: consistencyGate(f),
    sample: sampleGate(c),
    counter: counterGate(c),
    extreme: extremeGate(f),
  };
}
