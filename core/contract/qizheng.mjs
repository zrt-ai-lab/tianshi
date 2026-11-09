/**
 * 七政卡 —— CONTRACT.md §5
 *
 * 纯 ESM，零第三方依赖（Node >= 20）。
 *
 * 实现约定：
 * - 卡片字段严格按契约 §5，不多不少。
 * - 取不到的字段为 null；`confidence_cap` 由 gates.mjs 的 cap 计算，且不允许
 *   超过闸门给出的上限。
 * - `buildCard` 不编造 `invalid_if` / `drivers` / `evidence`，这些必须由
 *   `analysis`（上层 agent）提供，缺失时由 `validateCard` 报错。
 * - 时间统一 Asia/Shanghai（+08:00），不使用 `new Date().toISOString()`。
 */

import { confidenceCap } from './gates.mjs';
import { atrPct, ATR_PERIOD } from './yuzheng.mjs';

/* =============================== 常量 =============================== */

export const HORIZON_KEYS = Object.freeze(['short', 'mid', 'long']);

/** 各周期窗口（契约 §5） */
export const HORIZON_WINDOWS = Object.freeze({
  short: '1-5 交易日',
  mid: '1-3 个月',
  long: '12 个月',
});

export const VERDICTS = Object.freeze(['buy', 'watch', 'avoid', 'incomplete']);
export const DEFAULT_VERDICT = 'incomplete';

/** missing 项的「无数据」标注文案（validateCard 第 7 条检查它） */
export const MISSING_MARKER = '无数据';

/** 缺失数据项 → 受影响周期。未列出的键保守地视为影响短/中/长三个维度。 */
export const MISSING_DIMENSIONS = Object.freeze({
  quote: Object.freeze(['short', 'mid', 'long']),
  // gather 的「源级」缺失：主快照是否存在由 'quote' 一项负责，单源失败不影响维度
  'quote.tencent': Object.freeze([]),
  'quote.eastmoney': Object.freeze([]),
  kline_daily: Object.freeze(['short', 'mid', 'long']),
  fund_flow: Object.freeze(['short']),
  billboard: Object.freeze([]),
  sector: Object.freeze(['long']),
  'sector.match': Object.freeze([]),
  financials: Object.freeze(['mid', 'long']),
  valuation_pct: Object.freeze(['mid', 'long']),
  news: Object.freeze(['short']),
  announcements: Object.freeze([]),
  policy: Object.freeze(['mid', 'long']),
  shareholders: Object.freeze(['mid', 'long']),
});

export const DEFAULT_MISSING_DIMENSIONS = Object.freeze([...HORIZON_KEYS]);

/* ============================== 小工具 ============================== */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const SHANGHAI_TZ = 'Asia/Shanghai';
const SHANGHAI_OFFSET = '+08:00';

const shanghaiFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function shanghaiParts(date) {
  const parts = {};
  for (const { type, value } of shanghaiFormatter.formatToParts(date)) {
    parts[type] = value;
  }
  return parts;
}

/**
 * 当前时间（Asia/Shanghai），格式 `YYYY-MM-DDTHH:mm:ss+08:00`。
 * 禁止用 `new Date().toISOString()` 当业务时间。
 *
 * @param {Date|number} [now=new Date()]
 * @returns {string}
 */
export function nowShanghai(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('nowShanghai(): 无效时间');
  }
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${SHANGHAI_OFFSET}`;
}

/** `YYYY-MM-DDTHH:mm:ss+08:00` → `YYYYMMDD`；无法解析返回 null */
function dateStamp(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

/**
 * data_as_of = trade_date 的日期 + fetched_at 的采集时刻（转成 +08:00）。
 * 任一缺失/无法解析 → null（不猜日期，也不用本地时间补）。
 */
function deriveDataAsOf(facts) {
  const tradeDate = facts.trade_date;
  if (typeof tradeDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) return null;

  const fetchedAt = facts.fetched_at;
  if (typeof fetchedAt !== 'string') return null;
  if (!/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)$/.test(fetchedAt)) return null;

  const date = new Date(fetchedAt);
  if (Number.isNaN(date.getTime())) return null;

  const p = shanghaiParts(date);
  return `${tradeDate}T${p.hour}:${p.minute}:${p.second}${SHANGHAI_OFFSET}`;
}

function numOrNull(v) {
  return isNum(v) ? v : null;
}

/** 少量关键事实快照，便于复盘；取不到的字段为 null */
function buildFactsDigest(facts) {
  const quote = isObj(facts.quote) ? facts.quote : null;
  const fundFlow = isObj(facts.fund_flow) ? facts.fund_flow : null;
  const financials = isObj(facts.financials) ? facts.financials : null;
  const valuation = isObj(facts.valuation_pct) ? facts.valuation_pct : null;
  const sector = isObj(facts.sector) ? facts.sector : null;

  return {
    symbol: typeof facts.symbol === 'string' ? facts.symbol : null,
    name: typeof facts.name === 'string' ? facts.name : null,
    market: typeof facts.market === 'string' ? facts.market : null,
    trade_date: typeof facts.trade_date === 'string' ? facts.trade_date : null,
    is_trading: typeof facts.is_trading === 'boolean' ? facts.is_trading : null,
    price: numOrNull(quote?.price),
    pct_chg: numOrNull(quote?.pct_chg),
    amplitude: numOrNull(quote?.amplitude),
    pe_ttm: numOrNull(quote?.pe_ttm),
    pb: numOrNull(quote?.pb),
    main_net: numOrNull(fundFlow?.main_net),
    main_net_5d: numOrNull(fundFlow?.main_net_5d),
    roe: numOrNull(financials?.roe),
    revenue_yoy: numOrNull(financials?.revenue_yoy),
    netprofit_yoy: numOrNull(financials?.netprofit_yoy),
    pe_ttm_pct: numOrNull(valuation?.pe_ttm_pct),
    pb_pct: numOrNull(valuation?.pb_pct),
    sector_name: typeof sector?.name === 'string' ? sector.name : null,
    kline_n: Array.isArray(facts.kline_daily) ? facts.kline_daily.length : null,
    atr_pct: atrPct(facts.kline_daily, ATR_PERIOD),
  };
}

/** Horizon 归一化：只做类型兜底，不编造内容 */
function toHorizon(raw, key, baseCap) {
  const h = isObj(raw) ? raw : {};

  const dir = ['up', 'flat', 'down', 'unknown'].includes(h.dir) ? h.dir : 'unknown';
  const probUp = isNum(h.prob_up) ? h.prob_up : null;
  const range =
    Array.isArray(h.range) && h.range.length === 2 && h.range.every((v) => isNum(v))
      ? [h.range[0], h.range[1]]
      : null;

  const providedCap = isNum(h.confidence_cap) ? h.confidence_cap : baseCap;

  return {
    dir,
    prob_up: probUp,
    range,
    window: typeof h.window === 'string' && h.window.trim() !== '' ? h.window : HORIZON_WINDOWS[key],
    invalid_if: typeof h.invalid_if === 'string' ? h.invalid_if : '',
    drivers: Array.isArray(h.drivers) ? h.drivers.filter((d) => typeof d === 'string') : [],
    confidence_cap: Math.max(0, Math.min(providedCap, baseCap)),
  };
}

/* ============================== 构建卡片 ============================== */

/**
 * 构建七政卡。
 *
 * `analysis` 由上层/agent 提供：`{ as_of?, verdict?, sample_n?, evidence?,
 * counter_evidence?, horizons? }`。契约没有定义它的类型，这里只做最小消费：
 * - 不提供 `as_of` 时用 nowShanghai()；
 * - 不提供 `verdict` / `horizons` 时给 `incomplete` / `unknown` 骨架；
 * - 不编造 evidence、counter_evidence、invalid_if、drivers。
 *
 * @param {object} facts Facts
 * @param {object} gates runGates 输出
 * @param {object} risk computeRisk 输出
 * @param {object} [analysis]
 * @returns {object} QizhengCard
 */
export function buildCard(facts, gates, risk, analysis) {
  const f = isObj(facts) ? facts : {};
  const a = isObj(analysis) ? analysis : {};

  let asOf = typeof a.as_of === 'string' ? a.as_of.trim() : '';
  let day = asOf ? dateStamp(asOf) : null;
  if (!day) {
    asOf = nowShanghai();
    day = dateStamp(asOf);
  }

  const symbol = typeof f.symbol === 'string' ? f.symbol : '';
  const sampleN = isNum(a.sample_n)
    ? a.sample_n
    : isNum(a.ctx?.sample_n)
      ? a.ctx.sample_n
      : undefined;
  const baseCap = confidenceCap(f, { sample_n: sampleN });

  return {
    card_id: `qz_${day}_${symbol}`,
    symbol: typeof f.symbol === 'string' ? f.symbol : null,
    name: typeof f.name === 'string' ? f.name : null,
    as_of: asOf,
    data_as_of: deriveDataAsOf(f),
    verdict: VERDICTS.includes(a.verdict) ? a.verdict : DEFAULT_VERDICT,
    horizons: {
      short: toHorizon(a.horizons?.short, 'short', baseCap),
      mid: toHorizon(a.horizons?.mid, 'mid', baseCap),
      long: toHorizon(a.horizons?.long, 'long', baseCap),
    },
    risk: risk ?? null,
    evidence: Array.isArray(a.evidence) ? a.evidence.slice() : [],
    counter_evidence: Array.isArray(a.counter_evidence) ? a.counter_evidence.slice() : [],
    gates: gates ?? null,
    missing: Array.isArray(f.missing) ? f.missing.filter((m) => typeof m === 'string') : [],
    facts_digest: buildFactsDigest(f),
  };
}

/* ============================== 校验卡片 ============================== */

function affectedDimensions(item) {
  const key = item.startsWith('sector.match') ? 'sector.match' : item;
  if (Object.hasOwn(MISSING_DIMENSIONS, key)) {
    return MISSING_DIMENSIONS[key];
  }
  return DEFAULT_MISSING_DIMENSIONS;
}

/**
 * 校验七政卡（契约 §5 的 7 条）。
 * 返回全部错误，不短路。
 *
 * @param {object} card
 * @param {object} facts
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateCard(card, facts) {
  const errors = [];

  if (!isObj(card)) {
    return { ok: false, errors: ['card 不是对象'] };
  }

  const knownIds = new Set(
    (Array.isArray(facts?.evidence) ? facts.evidence : [])
      .map((e) => (isObj(e) ? e.evidence_id : null))
      .filter((id) => typeof id === 'string' && id.length > 0),
  );

  /* 1. evidence[].evidence_id 全部存在于 facts.evidence */
  if (!Array.isArray(card.evidence)) {
    errors.push('evidence 必须是数组');
  } else {
    card.evidence.forEach((item, index) => {
      if (!isObj(item)) {
        errors.push(`evidence[${index}] 不是对象`);
        return;
      }
      const id = item.evidence_id;
      if (typeof id !== 'string' || id.length === 0) {
        errors.push(`evidence[${index}].evidence_id 缺失`);
      } else if (!knownIds.has(id)) {
        errors.push(`evidence[${index}].evidence_id "${id}" 不存在于 facts.evidence`);
      }
    });
  }

  const horizons = isObj(card.horizons) ? card.horizons : {};

  for (const key of HORIZON_KEYS) {
    const h = horizons[key];

    /* 2. 任一 Horizon.invalid_if 为空 → error */
    if (!isObj(h)) {
      errors.push(`horizons.${key} 缺失`);
      continue;
    }
    if (typeof h.invalid_if !== 'string' || h.invalid_if.trim() === '') {
      errors.push(`horizons.${key}.invalid_if 为空（必填，非空）`);
    }

    const hasProb = h.prob_up !== null && h.prob_up !== undefined;

    /* 3. prob_up 若存在，必须 <= confidence_cap */
    if (hasProb) {
      if (!isNum(h.prob_up)) {
        errors.push(`horizons.${key}.prob_up 必须是 0-1 的数字或 null`);
      } else if (!isNum(h.confidence_cap)) {
        errors.push(`horizons.${key}.confidence_cap 缺失，无法校验 prob_up`);
      } else if (h.prob_up > h.confidence_cap) {
        errors.push(`horizons.${key}.prob_up ${h.prob_up} > confidence_cap ${h.confidence_cap}`);
      }
    }

    /* 6. dir === "unknown" 时 prob_up 必须为 null */
    if (h.dir === 'unknown' && hasProb) {
      errors.push(`horizons.${key}.dir=unknown 时 horizons.${key}.prob_up 必须为 null（无法给出上涨概率）`);
    }
  }

  /* 4. verdict === "buy" 的三条硬约束 */
  if (card.verdict === 'buy') {
    if (!isObj(card.gates)) {
      errors.push('verdict=buy 但缺少 gates，无法校验反证闸/一致性闸');
    } else {
      if (card.gates.counter?.status === 'fail') {
        errors.push('verdict=buy 但 gates.counter.status=fail（反证不足，禁止终局判断）');
      }
      if (card.gates.consistency?.status === 'fail') {
        errors.push('verdict=buy 但 gates.consistency.status=fail（一致性失败，禁止买入方向）');
      }
    }
    const positionCap = card.risk?.position_cap_pct;
    if (!isNum(positionCap) || !(positionCap > 0)) {
      errors.push(
        isNum(positionCap)
          ? `verdict=buy 但 risk.position_cap_pct=${positionCap}（必须 > 0）`
          : 'verdict=buy 但 risk.position_cap_pct 缺失（必须 > 0）',
      );
    }
  }

  /* 5. gates.data.status === "fail" 时 verdict 必须是 "incomplete" */
  if (card.gates?.data?.status === 'fail' && card.verdict !== 'incomplete') {
    errors.push(`gates.data=fail 时 verdict 必须是 "incomplete"，实际为 "${card.verdict}"`);
  }

  /* 7. missing 非空时，受影响维度必须在 drivers 里说明「无数据」 */
  const missing = Array.isArray(card.missing)
    ? card.missing
    : Array.isArray(facts?.missing)
      ? facts.missing
      : [];

  const byDimension = new Map();
  for (const item of missing) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    for (const dim of affectedDimensions(item)) {
      if (!byDimension.has(dim)) byDimension.set(dim, []);
      byDimension.get(dim).push(item);
    }
  }

  for (const [dim, items] of byDimension) {
    const h = horizons[dim];
    if (!isObj(h)) continue; // horizons.* 缺失已在第 2 条报错
    const drivers = Array.isArray(h.drivers) ? h.drivers.filter((d) => typeof d === 'string') : [];
    if (!drivers.some((d) => d.includes(MISSING_MARKER))) {
      errors.push(
        `missing 含 [${items.join(', ')}]，影响 ${dim} 维度，但 horizons.${dim}.drivers 未说明「${MISSING_MARKER}」`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
