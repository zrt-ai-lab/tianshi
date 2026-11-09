/**
 * 天市 · 公司面数据采集
 *
 * 覆盖六个维度：十大流通股东 / 十大股东 / 主营构成 / 限售解禁 / 龙虎榜席位 / 券商研报。
 *
 * 三条硬规则：
 *   1. 数必有据：取不到就是 null；接口明确说「没有」才是 []；绝不用 0 或空串冒充。
 *   2. 子项隔离：每个维度独立 try/catch，一个接口挂了不影响其他维度，
 *      失败原因写进 errors，成功但为空的数据保持空数组。
 *   3. 单位归一：接口里的「万股 / 万元」统一换算成「股 / 元」，
 *      0-1 小数的占比 / 毛利率统一换算成 %，字段注释写明口径。
 *
 * 接口盲区（均为 2026-11 实测，不是推测）：
 *   - RPT_LIFT_STAGE 按 FREE_DATE 升序 + pageSize=10 只返回**最早**的 10 条历史解禁。
 *     老股票（如 300750）未来解禁会被历史记录挤掉，取回来再筛是错的。
 *     必须把日期区间写进 filter（单引号日期可用，双引号会报「日期参数格式错误」）。
 *   - RPT_F10_FN_MAINOP 的 MAINOP_TYPE 实测是 1=按行业、2=按产品、3=按地区，
 *     与「3=地区、4=产品」的说法不一致；这里按实测值映射，1 不进产品/地区分组。
 *   - RPT_BILLBOARD_DAILYDETAILSBUY 每次命中只返回 5 个买入席位，
 *     pageSize=20 足够覆盖最近 3 个交易日（3×5=15 行）。
 *   - 东财数据中心「无数据」返回 HTTP 200 + success:false + code:9201 + message:"返回数据为空"，
 *     这是「确实没有」，不是取数失败；只有 HTTP 非 2xx / 非法 JSON / 结构异常才算失败。
 */

import { fetchRaw, decode, tryJson, num } from './http.mjs';
import { nowShanghai, todayShanghai } from './provenance.mjs';

const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const REPORT_API = 'https://reportapi.eastmoney.com/report/list';
const REFERER_DC = 'https://data.eastmoney.com/';
const REFERER_REPORT = 'https://data.eastmoney.com/report/';

/** 实际会请求的接口前缀，按固定顺序输出，便于报告里标注来源 */
const SOURCES = [
  `${DC}?reportName=RPT_F10_EH_FREEHOLDERS`,
  `${DC}?reportName=RPT_F10_EH_HOLDERS`,
  `${DC}?reportName=RPT_F10_FN_MAINOP`,
  `${DC}?reportName=RPT_LIFT_STAGE`,
  `${DC}?reportName=RPT_BILLBOARD_DAILYDETAILSBUY`,
  REPORT_API,
];

/* ── 小工具 ─────────────────────────────────────────────── */

function errorText(e) {
  return String(e?.message ?? e);
}

/** 600519 / sh600519 / 600519.SH → 600519；非法返回 null */
function normSymbol(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/\.(SH|SZ|BJ)$/i, '')
    .replace(/^(sh|sz|bj)/i, '');
  return /^\d{6}$/.test(s) ? s : null;
}

/**
 * SECUCODE 规则（本项目的约定）：
 *   6 开头 → .SH；0/3 开头 → .SZ；4/8/9 开头 → .BJ。
 * @param {string} symbol
 * @returns {string|null} 如 600519.SH；无法识别返回 null
 */
export function secuCode(symbol) {
  const s = normSymbol(symbol);
  if (!s) return null;
  if (s[0] === '6') return `${s}.SH`;
  if (s[0] === '0' || s[0] === '3') return `${s}.SZ`;
  if (s[0] === '4' || s[0] === '8' || s[0] === '9') return `${s}.BJ`;
  return null;
}

/** 取日期字符串前 10 位；不是 YYYY-MM-DD 返回 null（不猜） */
function ymd10(v) {
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** YYYY-MM-DD 加减月份；月末日期自动收敛（1/31 + 1 月 → 2/28） */
function addMonthsYmd(ymd, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const base = new Date(Date.UTC(y, mo - 1 + delta, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, lastDay));
  const p = (n) => String(n).padStart(2, '0');
  return `${base.getUTCFullYear()}-${p(base.getUTCMonth() + 1)}-${p(base.getUTCDate())}`;
}

/** 0-1 小数 → %（保留 4 位，消掉浮点噪声）；null 保持 null */
function fractionToPct(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 100 * 1e4) / 1e4;
}

/** 股东变动：数字字符串 → 股数；"不变"/"新进" 等原文保留；无值 null */
function holderChange(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = num(v);
  return n === null ? String(v) : n;
}

/** 数据中心查询 URL（filter 用 encodeURIComponent，保留括号、转义引号，与既有源码一致） */
function dcUrl(reportName, filter, { sortColumns, sortTypes, pageSize = 10, source = 'WEB', client = 'WEB' }) {
  return (
    `${DC}?reportName=${reportName}&columns=ALL&filter=${encodeURIComponent(filter).replace(/'/g, '%27')}` +
    `&pageNumber=1&pageSize=${pageSize}&sortColumns=${sortColumns}&sortTypes=${sortTypes}` +
    `&source=${source}&client=${client}`
  );
}

/** 带 UA / Referer 取 JSON；非 2xx、非法 JSON 一律抛错（由调用方隔离） */
async function getJson(url, referer) {
  const r = await fetchRaw(url, { headers: { Referer: referer } });
  if (!r.ok) throw new Error(r.error ?? `HTTP ${r.status}`);
  const json = tryJson(decode(r.buf));
  if (json === null) throw new Error('响应不是合法 JSON');
  return json;
}

/**
 * 东财数据中心 rows 提取。
 * result.data 是数组 → 返回；明确「返回数据为空」→ []；其余结构 → 抛错。
 */
function dcRows(json) {
  const rows = json?.result?.data;
  if (Array.isArray(rows)) return rows;
  const msg = String(json?.message ?? '');
  if (json?.success === false && (Number(json?.code) === 9201 || msg.includes('为空'))) return [];
  throw new Error(`接口异常：${msg || '缺少 result.data'}`);
}

async function getRowsSafe(url, referer = REFERER_DC) {
  try {
    return { ok: true, rows: dcRows(await getJson(url, referer)), error: null };
  } catch (e) {
    return { ok: false, rows: null, error: errorText(e) };
  }
}

async function rowsOrThrow(url, referer = REFERER_DC) {
  const r = await getRowsSafe(url, referer);
  if (!r.ok) throw new Error(r.error);
  return r.rows;
}

/** 取数组里最新报告期及该期行；日期缺失的行无法归属报告期，直接丢弃 */
function latestPeriod(rows) {
  const dated = [];
  let best = null;
  for (const r of rows) {
    const d = ymd10(r?.END_DATE ?? r?.REPORT_DATE);
    if (d === null) continue;
    dated.push({ row: r, date: d });
    if (best === null || d > best) best = d;
  }
  if (best === null) return { date: null, rows: [] };
  return { date: best, rows: dated.filter((x) => x.date === best).map((x) => x.row) };
}

/** 主营构成按收入降序（缺失排最后），保证「前 5 项」稳定 */
function byIncomeDesc(a, b) {
  const x = num(a.MAIN_BUSINESS_INCOME);
  const y = num(b.MAIN_BUSINESS_INCOME);
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
}

/* ── ① 十大流通股东 + 十大股东 ───────────────────────────── */

async function fetchShareholders(secu, errors) {
  const freeUrl = dcUrl('RPT_F10_EH_FREEHOLDERS', `(SECUCODE="${secu}")`, {
    sortColumns: 'END_DATE,HOLD_NUM',
    sortTypes: '-1,-1',
    pageSize: 10,
    source: 'HSF10',
    client: 'PC',
  });
  const allUrl = dcUrl('RPT_F10_EH_HOLDERS', `(SECUCODE="${secu}")`, {
    sortColumns: 'END_DATE,HOLD_NUM',
    sortTypes: '-1,-1',
    pageSize: 10,
    source: 'HSF10',
    client: 'PC',
  });

  // 两个接口都试；十大股东是可选块，流通股东失败时仍可保留
  const [free, all] = await Promise.all([getRowsSafe(freeUrl), getRowsSafe(allUrl)]);
  if (!free.ok) errors.push(`十大流通股东: ${free.error}`);
  if (!all.ok) errors.push(`十大股东: ${all.error}`);
  if (!free.ok && !all.ok) return null;

  const freePeriod = latestPeriod(free.rows ?? []);
  const allPeriod = latestPeriod(all.rows ?? []);

  return {
    report_date: freePeriod.date ?? allPeriod.date,
    free_top10: freePeriod.rows.map((r) => ({
      name: r.HOLDER_NAME ?? null,
      ratio: num(r.FREE_HOLDNUM_RATIO), // 接口已是 %，不换算
      hold_num: num(r.HOLD_NUM), // 股
      change: holderChange(r.HOLD_NUM_CHANGE), // 股数变动，或「不变」「新进」等原文
    })),
    top10: allPeriod.rows.map((r) => ({
      name: r.HOLDER_NAME ?? null,
      ratio: num(r.HOLD_NUM_RATIO), // %
    })),
  };
}

/* ── ② 主营构成 ─────────────────────────────────────────── */

async function fetchMainBusiness(secu) {
  const url = dcUrl('RPT_F10_FN_MAINOP', `(SECUCODE="${secu}")`, {
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
    pageSize: 30,
    source: 'HSF10',
    client: 'PC',
  });
  const rows = await rowsOrThrow(url);
  const period = latestPeriod(rows);

  const mapItem = (r) => ({
    item: r.ITEM_NAME ?? null,
    income: num(r.MAIN_BUSINESS_INCOME), // 元
    ratio: fractionToPct(r.MBI_RATIO), // 接口 0-1 小数 → %
    gross_margin: fractionToPct(r.GROSS_RPOFIT_RATIO), // 接口 0-1 小数 → %；未披露为 null
  });
  const pick = (type) =>
    period.rows
      .filter((r) => String(r.MAINOP_TYPE) === type)
      .sort(byIncomeDesc)
      .slice(0, 5)
      .map(mapItem);

  return {
    report_name: period.rows.find((r) => r.REPORT_NAME)?.REPORT_NAME ?? null,
    by_product: pick('2'), // 实测 2=按产品
    by_region: pick('3'), // 实测 3=按地区
  };
}

/* ── ③ 限售解禁 ─────────────────────────────────────────── */

async function fetchUnlocks(symbol, now) {
  const today = todayShanghai(now);
  const end = addMonthsYmd(today, 12);
  // 关键：日期区间必须进 filter，否则升序 + pageSize 只会拿到最早的历史记录
  const filter = `(SECURITY_CODE="${symbol}")(FREE_DATE>='${today}')(FREE_DATE<='${end}')`;
  const url = dcUrl('RPT_LIFT_STAGE', filter, {
    sortColumns: 'FREE_DATE',
    sortTypes: '1',
    pageSize: 50,
    source: 'WEB',
    client: 'WEB',
  });
  const rows = await rowsOrThrow(url);

  return rows
    .map((r) => {
      const date = ymd10(r.FREE_DATE);
      const sharesWan = num(r.CURRENT_FREE_SHARES); // 万股
      const capWan = num(r.LIFT_MARKET_CAP); // 万元
      return {
        date,
        shares: sharesWan === null ? null : Math.round(sharesWan * 10000), // 股
        market_cap: capWan === null ? null : Math.round(capWan * 10000 * 100) / 100, // 元
        type: r.FREE_SHARES_TYPE ?? null,
      };
    })
    .filter((r) => r.date !== null && r.date >= today && r.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/* ── ④ 龙虎榜席位明细 ───────────────────────────────────── */

async function fetchBillboardSeats(symbol) {
  const url = dcUrl('RPT_BILLBOARD_DAILYDETAILSBUY', `(SECURITY_CODE="${symbol}")`, {
    sortColumns: 'TRADE_DATE',
    sortTypes: '-1',
    pageSize: 20,
    source: 'WEB',
    client: 'WEB',
  });
  const rows = await rowsOrThrow(url);

  const dated = [];
  for (const r of rows) {
    const date = ymd10(r.TRADE_DATE);
    if (date !== null) dated.push({ row: r, date });
  }
  // 最近 3 个「有榜的交易日」（不是最近 3 个自然日；茅台最近一次上榜还是 2013 年）
  const dates = [];
  for (const x of dated) {
    if (!dates.includes(x.date)) dates.push(x.date);
    if (dates.length === 3) break;
  }
  const keep = new Set(dates);

  return dated
    .filter((x) => keep.has(x.date))
    .map(({ row: r, date }) => ({
      date,
      seat: r.OPERATEDEPT_NAME ?? null,
      is_institution: String(r.OPERATEDEPT_NAME ?? '').includes('机构'),
      buy: num(r.BUY), // 元
      sell: num(r.SELL), // 元；未披露为 null
      net: num(r.NET), // 元
    }));
}

/* ── ⑤ 券商研报 ─────────────────────────────────────────── */

async function fetchReports(symbol, now) {
  const today = todayShanghai(now);
  const begin = addMonthsYmd(today, -3);
  const q = new URLSearchParams({
    industryCode: '*',
    pageSize: '10',
    industry: '*',
    rating: '',
    ratingChange: '',
    beginTime: begin,
    endTime: today,
    pageNo: '1',
    qType: '0',
    code: symbol,
    p: '1',
    pageNum: '1',
  });
  const json = await getJson(`${REPORT_API}?${q}`, REFERER_REPORT);
  if (!Array.isArray(json?.data)) throw new Error('接口异常：缺少 data 数组');

  return json.data.slice(0, 10).map((r) => {
    const rating = typeof r.emRatingName === 'string' && r.emRatingName.trim() !== '' ? r.emRatingName : null;
    const org = r.orgSName || r.orgName || null;
    return {
      date: ymd10(r.publishDate),
      org: org && String(org).trim() !== '' ? org : null,
      title: r.title || null,
      rating, // 可能为空 → null
      eps: num(r.predictThisYearEps), // 元/股
      pe: num(r.predictThisYearPe), // 倍
    };
  });
}

/* ── 主入口 ─────────────────────────────────────────────── */

/**
 * 采集一只股票的公司面数据。
 *
 * @param {object} facts gather() 的输出，只用到 facts.symbol（6 位代码）
 * @param {{now?: Date}} [opts] now 用于确定「今天」「未来 12 个月」「近 3 个月」，
 *        同时写进 fetched_at；测试可传入固定时间
 * @returns {Promise<{
 *   ok: boolean,
 *   symbol: string,
 *   fetched_at: string,
 *   shareholders: {report_date:string|null, free_top10:Array, top10:Array}|null,
 *   main_business: {report_name:string|null, by_product:Array, by_region:Array}|null,
 *   unlocks: Array|null,
 *   billboard_seats: Array|null,
 *   reports: Array|null,
 *   errors: string[],
 *   sources: string[]
 * }>}
 *
 * 空值语义：
 *   - 对象块（shareholders / main_business）为 null = 取数失败；非 null 但内部数组为空 = 接口确认没有。
 *   - 数组块（unlocks / billboard_seats / reports）为 null = 取数失败；[] = 接口确认没有。
 *   - 任一子项失败 → errors 非空、ok=false；其余子项照常返回。
 */
export async function fetchCompany(facts, { now = new Date() } = {}) {
  const symbol = normSymbol(facts?.symbol);
  const secu = secuCode(symbol);
  const fetched_at = nowShanghai(now);
  const errors = [];

  if (!symbol || !secu) {
    return {
      ok: false,
      symbol: symbol ?? '',
      fetched_at,
      shareholders: null,
      main_business: null,
      unlocks: null,
      billboard_seats: null,
      reports: null,
      errors: [`无法识别的股票代码: ${facts?.symbol ?? '(空)'}`],
      sources: [],
    };
  }

  const guard = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${label}: ${errorText(e)}`);
      return null;
    }
  };

  const [shareholders, main_business, unlocks, billboard_seats, reports] = await Promise.all([
    guard('十大股东', () => fetchShareholders(secu, errors)),
    guard('主营构成', () => fetchMainBusiness(secu)),
    guard('限售解禁', () => fetchUnlocks(symbol, now)),
    guard('龙虎榜席位', () => fetchBillboardSeats(symbol)),
    guard('券商研报', () => fetchReports(symbol, now)),
  ]);

  return {
    ok: errors.length === 0,
    symbol,
    fetched_at,
    shareholders,
    main_business,
    unlocks,
    billboard_seats,
    reports,
    errors,
    sources: [...SOURCES],
  };
}
