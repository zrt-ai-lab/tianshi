/**
 * 天市 · 校准与回填（T-ledger）
 *
 * 契约：CONTRACT.md §7
 *
 * 统计纪律：
 *   - 任何分母为 0 的比率/均值/中位数一律返回 null，绝不返回 0 假装有统计。
 *   - hit_rate 只统计 realized !== null、预测方向与实际方向均可判定的样本。
 *   - brier 只统计 prob_up 为 0-1 有效数字且有实际结果的样本。
 *   - 纯日期计算，不读取隐式当前时间（不使用 Date.now()）。
 *
 * 纯 ESM，零运行时依赖，Node >= 20。
 */

/** horizons 窗口（契约 §7：short 按 5 天、mid 按 90 天、long 按 365 天计）。 */
export const HORIZON_WINDOW_DAYS = Object.freeze({ short: 5, mid: 90, long: 365 });

/** 方向阈值：ret_pct > +1 为 up，< -1 为 down，其余为 flat（契约 §7 + 任务约定）。 */
export const DIRECTION_THRESHOLD_PCT = 1;

const HORIZON_KEYS = Object.freeze(['short', 'mid', 'long']);
const CALIBRATION_BUCKETS = Object.freeze(['0-20', '20-40', '40-60', '60-80', '80-100']);
const GATE_KEYS = Object.freeze(['data', 'consistency', 'sample', 'counter', 'extreme']);
const RISK_LEVELS = Object.freeze([1, 2, 3, 4, 5]);

const DAY_MS = 24 * 60 * 60 * 1000;

function isRecordLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDirection(value) {
  return value === 'up' || value === 'flat' || value === 'down';
}

/** 解析 YYYY-MM-DD 前缀（也接受完整 ISO8601），返回 UTC 日序号；非法返回 null。 */
function parseDateOnly(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[Tt ])/.exec(value.trim());
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const stamp = Date.UTC(year, month - 1, day);
  const probe = new Date(stamp);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(stamp / DAY_MS);
}

/** ret_pct 的方向分类；非有限数字返回 null。 */
function directionFromReturn(retPct) {
  if (typeof retPct !== 'number' || !Number.isFinite(retPct)) return null;
  if (retPct > DIRECTION_THRESHOLD_PCT) return 'up';
  if (retPct < -DIRECTION_THRESHOLD_PCT) return 'down';
  return 'flat';
}

/** 实际方向：优先按 ret_pct 阈值判定；缺失时退回 realized.dir。 */
function realizedDirection(realized) {
  const fromReturn = directionFromReturn(realized.ret_pct);
  if (fromReturn !== null) return fromReturn;
  return isDirection(realized.dir) ? realized.dir : null;
}

function toProbability(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

/** 概率分桶：左闭右开；1.0 归入 80-100。0.6 → "60-80"。 */
function bucketIndexOf(probability) {
  if (probability >= 1) return 4;
  return Math.min(4, Math.floor(probability * 5));
}

function normalizeRiskLevel(value) {
  const level = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(level) && level >= 1 && level <= 5 ? level : null;
}

function mean(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function recordedAtOf(record) {
  if (typeof record.recorded_at !== 'string') return 0;
  const stamp = Date.parse(record.recorded_at);
  return Number.isFinite(stamp) ? stamp : 0;
}

function cardRevisionOf(card) {
  return Number.isInteger(card.revision) ? card.revision : -1;
}

/**
 * 找出已到期、待回填结果的 horizon。
 *
 * 到期日 = card.as_of 的日期 + 窗口天数；today >= 到期日 即视为到期。
 * 只返回已到期的项（due 恒为 true）；as_of 不合法的卡被跳过。
 *
 * @param {object[]} cards
 * @param {string} today YYYY-MM-DD（也接受完整 ISO8601）
 * @returns {{ card: object, horizon: string, due: boolean }[]}
 */
export function dueCards(cards, today) {
  const todayDay = parseDateOnly(today);
  if (todayDay === null) {
    throw new TypeError('dueCards(cards, today): today must be a date string like "YYYY-MM-DD"');
  }

  const result = [];
  const cardList = Array.isArray(cards) ? cards : [];

  for (const card of cardList) {
    if (!isRecordLike(card)) continue;
    const asOfDay = parseDateOnly(card.as_of);
    if (asOfDay === null) continue;
    if (!isRecordLike(card.horizons)) continue;

    for (const horizon of HORIZON_KEYS) {
      if (!isRecordLike(card.horizons[horizon])) continue;
      const dueDay = asOfDay + HORIZON_WINDOW_DAYS[horizon];
      if (todayDay >= dueDay) {
        result.push({ card, horizon, due: true });
      }
    }
  }

  return result;
}

/**
 * 按契约 §7 计算校准指标。
 *
 * @param {object[]} cards 七政卡（同一 card_id 的多个 revision 只取最新一条）
 * @param {object[]} outcomes Outcome 记录
 * @returns {{
 *   by_horizon: Record<string, { n: number, hit_rate: number | null, brier: number | null }>,
 *   calibration: { bucket: string, n: number, predicted: number | null, actual: number | null }[],
 *   risk_vs_drawdown: { level: number, n: number, median_max_dd: number | null }[],
 *   gate_fail_stats: { gate: string, fail: number, warn: number, pass: number }[],
 * }}
 */
export function score(cards = [], outcomes = []) {
  const cardList = Array.isArray(cards) ? cards.filter(isRecordLike) : [];
  const outcomeList = Array.isArray(outcomes) ? outcomes.filter(isRecordLike) : [];

  // 同一 card_id 的多个 revision：保留 revision 最大、其次 recorded_at 最新的一条，避免重复计数。
  const cardById = new Map();
  for (const card of cardList) {
    if (typeof card.card_id !== 'string' || card.card_id === '') continue;
    const existing = cardById.get(card.card_id);
    if (existing === undefined) {
      cardById.set(card.card_id, card);
      continue;
    }
    const revision = cardRevisionOf(card);
    const existingRevision = cardRevisionOf(existing);
    if (
      revision > existingRevision ||
      (revision === existingRevision && recordedAtOf(card) >= recordedAtOf(existing))
    ) {
      cardById.set(card.card_id, card);
    }
  }

  // 同一 (card_id, horizon) 只保留一条 outcome：已有 realized 的不会被后续 realized=null 覆盖。
  const outcomeByKey = new Map();
  for (const outcome of outcomeList) {
    if (typeof outcome.card_id !== 'string' || !HORIZON_KEYS.includes(outcome.horizon)) continue;
    if (!cardById.has(outcome.card_id)) continue;
    const key = `${outcome.card_id}\u0000${outcome.horizon}`;
    const previous = outcomeByKey.get(key);
    if (
      previous === undefined ||
      isRecordLike(outcome.realized) ||
      !isRecordLike(previous.realized)
    ) {
      outcomeByKey.set(key, outcome);
    }
  }

  const horizonAggregates = new Map(
    HORIZON_KEYS.map((horizon) => [
      horizon,
      { n: 0, hits: 0, hitDenominator: 0, brierErrors: [] },
    ]),
  );
  const calibrationAggregates = CALIBRATION_BUCKETS.map((bucket) => ({
    bucket,
    predicted: [],
    actual: [],
  }));
  const riskAggregates = new Map(
    RISK_LEVELS.map((level) => [level, { n: 0, drawdowns: [] }]),
  );

  for (const outcome of outcomeByKey.values()) {
    const card = cardById.get(outcome.card_id);
    if (card === undefined) continue;
    const realized = outcome.realized;
    if (!isRecordLike(realized)) continue; // 未回填，不算样本

    const aggregate = horizonAggregates.get(outcome.horizon);
    aggregate.n += 1;

    const actual = realizedDirection(realized);
    const horizon = isRecordLike(card.horizons) ? card.horizons[outcome.horizon] : null;
    const predicted = isRecordLike(horizon) && isDirection(horizon.dir) ? horizon.dir : null;

    if (actual !== null && predicted !== null) {
      aggregate.hitDenominator += 1;
      if (predicted === actual) aggregate.hits += 1;
    }

    const probability = isRecordLike(horizon) ? toProbability(horizon.prob_up) : null;
    if (probability !== null && actual !== null) {
      const actualUp = actual === 'up' ? 1 : 0;
      aggregate.brierErrors.push((probability - actualUp) ** 2);

      const bucket = calibrationAggregates[bucketIndexOf(probability)];
      bucket.predicted.push(probability);
      bucket.actual.push(actualUp);
    }

    const level = isRecordLike(card.risk) ? normalizeRiskLevel(card.risk.level) : null;
    if (level !== null) {
      const riskAggregate = riskAggregates.get(level);
      riskAggregate.n += 1;
      if (typeof realized.max_dd_pct === 'number' && Number.isFinite(realized.max_dd_pct)) {
        riskAggregate.drawdowns.push(realized.max_dd_pct);
      }
    }
  }

  const gateAggregates = new Map(
    GATE_KEYS.map((gate) => [gate, { fail: 0, warn: 0, pass: 0 }]),
  );
  for (const card of cardById.values()) {
    if (!isRecordLike(card.gates)) continue;
    for (const gate of GATE_KEYS) {
      const result = card.gates[gate];
      if (!isRecordLike(result)) continue;
      if (result.status === 'fail' || result.status === 'warn' || result.status === 'pass') {
        gateAggregates.get(gate)[result.status] += 1;
      }
    }
  }

  const byHorizon = {};
  for (const horizon of HORIZON_KEYS) {
    const aggregate = horizonAggregates.get(horizon);
    byHorizon[horizon] = {
      n: aggregate.n,
      hit_rate:
        aggregate.hitDenominator > 0 ? aggregate.hits / aggregate.hitDenominator : null,
      brier: mean(aggregate.brierErrors),
    };
  }

  return {
    by_horizon: byHorizon,
    calibration: calibrationAggregates.map((aggregate) => ({
      bucket: aggregate.bucket,
      n: aggregate.predicted.length,
      predicted: mean(aggregate.predicted),
      actual: mean(aggregate.actual),
    })),
    risk_vs_drawdown: RISK_LEVELS.map((level) => {
      const aggregate = riskAggregates.get(level);
      return {
        level,
        n: aggregate.n,
        median_max_dd: median(aggregate.drawdowns),
      };
    }),
    gate_fail_stats: GATE_KEYS.map((gate) => ({
      gate,
      ...gateAggregates.get(gate),
    })),
  };
}
