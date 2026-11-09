/**
 * 玉衡 · 风控映射 —— CONTRACT.md §4
 *
 * 纯 ESM，零第三方依赖（Node >= 20）。
 *
 * 实现约定：
 * - 5 级映射表为硬编码常量（`RISK_LEVEL_MAP`），不允许模型改写。
 * - `atrPct()` 是 ATR% 的唯一实现，供本模块与 gates.mjs（极端值闸）共用。
 * - 取不到的数据一律返回 null，不用 0 / 占位符补全（数必有据）。
 */

/* =============================== 阈值 =============================== */

export const ATR_PERIOD = 14; // ATR 窗口（契约 atrPct 的默认 n）
export const ATR_PCT_LOW = 2; // level 1 要求 ATR% < 2
export const ATR_PCT_HIGH = 5; // ATR% >= 5 直接 level 4（与极端值闸取值一致，边界不歧义）
export const PE_PCT_LOW = 60; // level 1 要求 PE 分位 < 60；level 3 为 60–80
export const PE_PCT_HIGH = 80; // PE 分位 > 80 → level 4
export const ATR_MULT = 4; // drawdown_est ≈ -(atr_pct * 4 * k)
export const DRAWDOWN_K_MIN = 1;
export const DRAWDOWN_K_MAX = 1.5;

/** 硬编码映射表：level → 仓位上限 / 止损 */
export const RISK_LEVEL_MAP = Object.freeze({
  1: Object.freeze({ position_cap_pct: 20, stop_loss_pct: -12 }),
  2: Object.freeze({ position_cap_pct: 15, stop_loss_pct: -10 }),
  3: Object.freeze({ position_cap_pct: 8, stop_loss_pct: -8 }),
  4: Object.freeze({ position_cap_pct: 3, stop_loss_pct: -6 }),
  5: Object.freeze({ position_cap_pct: 0, stop_loss_pct: null }),
});

/* ============================== 小工具 ============================== */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const fmt = (v) => (isNum(v) ? String(Number(v.toFixed(2))) : 'null');

const fmtPct = (v) => {
  const rounded = Math.round(v);
  return `${rounded === 0 ? 0 : rounded}%`;
};

/* ================================ ATR ================================ */

/**
 * ATR%（平均真实波幅 / 最新收盘价 * 100）。
 *
 * 契约未指定平滑方式，这里用「最近 n 根 TR 的算术平均」：
 * TR = max(high - low, |high - prev_close|, |low - prev_close|)。
 * K 线不足 2 根、或取不到有效价格时返回 null（不猜）。
 *
 * @param {Array<{high:number, low:number, close:number}>} kline_daily 升序日 K
 * @param {number} [n=ATR_PERIOD]
 * @returns {number|null}
 */
export function atrPct(kline_daily, n = ATR_PERIOD) {
  if (!Array.isArray(kline_daily) || kline_daily.length < 2) return null;

  const period = isNum(n) && n > 0 ? Math.floor(n) : ATR_PERIOD;
  const bars = kline_daily.slice(-(period + 1));
  const trs = [];

  for (let i = 1; i < bars.length; i += 1) {
    const cur = bars[i];
    const prev = bars[i - 1];
    if (!isObj(cur) || !isObj(prev)) continue;

    const high = cur.high;
    const low = cur.low;
    const prevClose = prev.close;
    if (!isNum(high) || !isNum(low) || !isNum(prevClose)) continue;

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    if (isNum(tr)) trs.push(tr);
  }

  if (trs.length === 0) return null;

  const lastBar = bars[bars.length - 1];
  const lastClose = isObj(lastBar) ? lastBar.close : null;
  if (!isNum(lastClose) || lastClose <= 0) return null;

  const atr = trs.reduce((sum, tr) => sum + tr, 0) / trs.length;
  return (atr / lastClose) * 100;
}

/**
 * 回撤估计：≈ -(atr_pct * 4 * k)，k ∈ [1.0, 1.5]，输出区间字符串。
 * 契约提到「历史最大回撤分位」，但 Facts 中没有该数据，按公式用 k 区间覆盖；
 * ATR 不可得时返回 null。
 */
function estimateDrawdown(atr) {
  if (!isNum(atr)) return null;
  const low = -(atr * ATR_MULT * DRAWDOWN_K_MIN);
  const high = -(atr * ATR_MULT * DRAWDOWN_K_MAX);
  return `${fmtPct(low)}~${fmtPct(high)}`;
}

/* ============================== 风控映射 ============================== */

/**
 * 计算玉衡风险等级。
 *
 * 判定顺序（与契约映射表一致）：
 * 5 → 4 → 3 → 1 → 2（level 2 是「level 1 有一条不达标」的兜底）。
 *
 * @param {object} facts Facts
 * @param {object} gates Gates（runGates 输出）
 * @returns {{level: 1|2|3|4|5, triggers: string[], position_cap_pct: number, stop_loss_pct: number|null, drawdown_est: string|null}}
 */
export function computeRisk(facts, gates) {
  const f = isObj(facts) ? facts : {};
  const g = isObj(gates) ? gates : {};

  const atr = atrPct(f.kline_daily, ATR_PERIOD);
  const valuation = isObj(f.valuation_pct) ? f.valuation_pct : null;
  const fundFlow = isObj(f.fund_flow) ? f.fund_flow : null;

  const pePct = valuation && isNum(valuation.pe_ttm_pct) ? valuation.pe_ttm_pct : null;
  const mainNet = fundFlow && isNum(fundFlow.main_net) ? fundFlow.main_net : null;
  const mainNet5d = fundFlow && isNum(fundFlow.main_net_5d) ? fundFlow.main_net_5d : null;

  const dataStatus = g.data?.status ?? null;
  const consistencyStatus = g.consistency?.status ?? null;
  const sampleStatus = g.sample?.status ?? null;
  const extremeStatus = g.extreme?.status ?? null;

  const withDetail = (prefix, detail) =>
    typeof detail === 'string' && detail.length > 0 ? `${prefix}（${detail}）` : prefix;

  // gates 缺失/不完整时无法判定，按 fail-closed 直接给 level 5（不假装低风险）
  const GATE_KEYS = ['data', 'consistency', 'sample', 'counter', 'extreme'];
  const gatesComplete = GATE_KEYS.every((key) => ['pass', 'warn', 'fail'].includes(g[key]?.status));
  if (!gatesComplete) {
    const mapped = RISK_LEVEL_MAP[5];
    return {
      level: 5,
      triggers: ['gates 缺失或不完整，无法完成风控判定'],
      position_cap_pct: mapped.position_cap_pct,
      stop_loss_pct: mapped.stop_loss_pct,
      drawdown_est: estimateDrawdown(atr),
    };
  }

  const triggers = [];
  let level;

  // level 5：数据闸 fail，或一致性闸 fail
  if (dataStatus === 'fail' || consistencyStatus === 'fail') {
    level = 5;
    if (dataStatus === 'fail') triggers.push(withDetail('数据闸 fail', g.data?.detail));
    if (consistencyStatus === 'fail') triggers.push(withDetail('一致性闸 fail', g.consistency?.detail));
  }

  // level 4：PE 分位 > 80，或 ATR% > 5，或一致性闸 warn，或样本闸 warn
  else if (
    (pePct !== null && pePct > PE_PCT_HIGH) ||
    (atr !== null && atr >= ATR_PCT_HIGH) ||
    consistencyStatus === 'warn' ||
    sampleStatus === 'warn'
  ) {
    level = 4;
    if (pePct !== null && pePct > PE_PCT_HIGH) {
      triggers.push(`PE 分位 ${fmt(pePct)} > ${PE_PCT_HIGH}`);
    }
    if (atr !== null && atr > ATR_PCT_HIGH) {
      triggers.push(`ATR% ${fmt(atr)} >= ${ATR_PCT_HIGH}`);
    }
    if (consistencyStatus === 'warn') {
      triggers.push(withDetail('一致性闸 warn', g.consistency?.detail));
    }
    if (sampleStatus === 'warn') {
      triggers.push(withDetail('样本闸 warn', g.sample?.detail));
    }
  }

  // level 3：PE 分位 60–80，或资金连续净流出，或数据闸 warn
  else {
    const peInMid = pePct !== null && pePct >= PE_PCT_LOW && pePct <= PE_PCT_HIGH;
    // 极端值闸 warn（涨跌停附近/振幅过大/估值尾部）本身就是风险信号，
    // 至少升到 level 3，不允许因为「ATR 低 + PE 低」而落到 level 2。
    const extremeWarn = extremeStatus === 'warn';
    // 「连续净流出」契约未定义口径：取「当日主力净流出 且 5 日累计净流出」，
    // 缺少 main_net_5d 时无法确认「连续」，不触发。
    const outflowStreak = mainNet !== null && mainNet < 0 && mainNet5d !== null && mainNet5d < 0;
    const dataWarn = dataStatus === 'warn';

    if (peInMid || outflowStreak || dataWarn || extremeWarn) {
      level = 3;
      if (peInMid) {
        triggers.push(`PE 分位 ${fmt(pePct)} 落在 ${PE_PCT_LOW}–${PE_PCT_HIGH}`);
      }
      if (outflowStreak) {
        triggers.push(`主力资金连续净流出（当日 ${fmt(mainNet)} 元、5 日累计 ${fmt(mainNet5d)} 元均为负）`);
      }
      if (dataWarn) {
        triggers.push(withDetail('数据闸 warn', g.data?.detail));
      }
      if (extremeWarn) {
        triggers.push(withDetail('极端值闸 warn', g.extreme?.detail));
      }
    } else {
      // level 1：ATR% < 2 且 PE 分位 < 60 且 无极端值闸 warn
      const atrLow = atr !== null && atr < ATR_PCT_LOW;
      const peLow = pePct !== null && pePct < PE_PCT_LOW;
      const noExtreme = extremeStatus !== 'warn';

      if (atrLow && peLow && noExtreme) {
        level = 1;
        triggers.push(`ATR% ${fmt(atr)} < ${ATR_PCT_LOW}`);
        triggers.push(`PE 分位 ${fmt(pePct)} < ${PE_PCT_LOW}`);
        triggers.push('极端值闸无 warn');
      } else {
        // level 2：level 1 的条件有一条不达标
        level = 2;
        if (!atrLow) {
          triggers.push(
            atr === null ? 'ATR% 无法计算，不满足「ATR% < 2」' : `ATR% ${fmt(atr)} ≥ ${ATR_PCT_LOW}`,
          );
        }
        if (!peLow) {
          triggers.push(
            pePct === null
              ? 'PE 分位缺失，不满足「PE 分位 < 60」'
              : `PE 分位 ${fmt(pePct)} ≥ ${PE_PCT_LOW}`,
          );
        }
        if (!noExtreme) {
          triggers.push(withDetail('极端值闸 warn', g.extreme?.detail));
        }
      }
    }
  }

  const mapped = RISK_LEVEL_MAP[level];

  return {
    level,
    triggers,
    position_cap_pct: mapped.position_cap_pct,
    stop_loss_pct: mapped.stop_loss_pct,
    drawdown_est: estimateDrawdown(atr),
  };
}
