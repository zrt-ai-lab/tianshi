/**
 * 天市 · 消息面 / 政策面数据采集
 *
 * 数据边界（先读这段再用输出）：
 *   1. 本模块只**搬运**东方财富新闻搜索接口原始返回的 title / content。
 *      清洗掉 `<em>` 高亮等 HTML 标签后把正文截断到 200 字，不做摘要改写、
 *      不做语义归纳、不推测因果 —— summary 是原文片段，不是模型生成的摘要。
 *   2. 「政策新闻」是关键词命中，不是政策事实认定。命中的关键词一并返回，可复核。
 *   3. sentiment 是**词袋粗分**，只统计关键词是否出现，**不代表真实情绪**，
 *      不得当作利好/利空结论使用。
 *   4. 取不到就是 null / 空数组，并在 errors 里写明原因，绝不补数。
 */

import { nowShanghai } from './provenance.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const REFERER = 'https://so.eastmoney.com/';
const SEARCH_ENDPOINT = 'https://search-api-web.eastmoney.com/search/jsonp';
const SOURCE = 'search-api-web.eastmoney.com/search/jsonp';
const TIMEOUT_MS = 9000;
const MAX_SUMMARY_CHARS = 200;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/** 政策关键词表：标题或摘要命中任一即视为政策类新闻 */
export const POLICY_KEYWORDS = Object.freeze([
  '政策',
  '监管',
  '国务院',
  '发改委',
  '工信部',
  '证监会',
  '财政部',
  '央行',
  '补贴',
  '规范',
  '意见',
  '规划',
  '试点',
  '标准',
  '关税',
  '出口管制',
  '反垄断',
  '税收',
  '专项',
  '指导意见',
  '管理办法',
]);

/** 正面词（词袋，仅表示词面出现，不代表真实情绪） */
export const POSITIVE_WORDS = Object.freeze([
  '增长',
  '提升',
  '超预期',
  '利好',
  '中标',
  '突破',
  '创新高',
  '扩产',
  '回购',
  '增持',
  '补贴',
  '获批',
  '签约',
]);

/** 负面词（词袋，仅表示词面出现，不代表真实情绪） */
export const NEGATIVE_WORDS = Object.freeze([
  '下滑',
  '亏损',
  '处罚',
  '立案',
  '减持',
  '风险',
  '下调',
  '违规',
  '诉讼',
  '退市',
  '警示',
  '冻结',
  '质押',
]);

/* ── 文本清洗 ───────────────────────────────────────────── */

const NAMED_ENTITIES = Object.freeze({
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/**
 * 清洗接口返回的 HTML 片段：
 *   ① 去掉 <em> / </em> 以及其它所有 HTML 标签（含嵌套、多个）
 *   ② 解码常见 HTML 实体（先剥标签再解码，避免把 &lt;em&gt; 当成标签剥掉）
 *   ③ 空白折叠为单个空格
 *
 * 注意：只做「清洗」，不改写任何文字。
 *
 * @param {unknown} input
 * @returns {string}
 */
export function cleanText(input) {
  if (input === null || input === undefined) return '';
  let s = String(input);
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    const key = String(body).toLowerCase();
    if (key.startsWith('#x')) {
      const cp = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (key.startsWith('#')) {
      const cp = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 按字符（而非 UTF-16 码元）截断，避免把代理对切断。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncateText(text, max = MAX_SUMMARY_CHARS) {
  const s = String(text ?? '');
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

/**
 * 行业名去掉罗马数字后缀：白酒Ⅱ → 白酒、半导体Ⅲ → 半导体。
 * 东方财富行业名常用 U+2160–U+217F，也兼容 "白酒 II" / "白酒II" 写法。
 * 注意：不能无条件剥 ASCII 罗马字符，否则 "AI" 会被削成 "A"。
 *
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeSectorName(name) {
  if (typeof name !== 'string') return '';
  return name
    .trim()
    .replace(/[\u2160-\u217F]+$/u, '')
    .trim()
    .replace(/\s+(?:I{1,3}|IV|V|VI{0,3}|IX|X)$/i, '')
    .trim()
    .replace(/(?<=[\u4E00-\u9FFF])(?:I{1,3}|IV|VI{0,3}|IX|X)$/, '')
    .trim();
}

/* ── 关键词匹配与词袋情绪 ───────────────────────────────── */

/**
 * 政策关键词命中（按关键词表顺序返回，方便复核）。
 * @param {string} text 已清洗的标题 / 摘要
 * @returns {string[]}
 */
export function matchPolicyKeywords(text) {
  const hay = String(text ?? '');
  if (!hay) return [];
  return POLICY_KEYWORDS.filter((kw) => hay.includes(kw));
}

/** 词袋命中数：每个词在同一段文本里最多算一次 */
function bagHits(text, words) {
  const s = String(text ?? '');
  if (!s) return 0;
  return words.filter((w) => s.includes(w)).length;
}

/**
 * 情绪粗分（词袋，**不代表真实情绪**）。
 *
 * 规则：标题、摘要各自算一次命中；同一段文本里同一个词只算一次。
 * 取命中最多的类别；两边相同或都没有命中则为 neutral。
 *
 * @param {string} title
 * @param {string} summary
 * @returns {{positive:number, negative:number, label:'positive'|'negative'|'neutral'}}
 */
export function classifySentiment(title = '', summary = '') {
  const positive = bagHits(title, POSITIVE_WORDS) + bagHits(summary, POSITIVE_WORDS);
  const negative = bagHits(title, NEGATIVE_WORDS) + bagHits(summary, NEGATIVE_WORDS);
  const label = positive > negative ? 'positive' : negative > positive ? 'negative' : 'neutral';
  return { positive, negative, label };
}

/* ── JSONP ──────────────────────────────────────────────── */

/**
 * 剥 JSONP 外壳：`cb({...})` / `cb({...});` → 对象。
 * 解析失败返回 null（调用方负责记 error）。
 *
 * @param {unknown} text
 * @returns {object|null}
 */
export function parseJsonp(text) {
  if (typeof text !== 'string') return null;
  const m = /^[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?$/.exec(text.trim());
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    return data !== null && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/* ── 请求 ───────────────────────────────────────────────── */

/** 拼东方财富新闻搜索 URL（param 是 URL 编码后的 JSON） */
function buildSearchUrl(keyword, pageSize) {
  const param = {
    uid: '',
    keyword,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default',
        sort: 'default',
        pageIndex: 1,
        pageSize,
        preTag: '<em>',
        postTag: '</em>',
      },
    },
  };
  return `${SEARCH_ENDPOINT}?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`;
}

async function getText(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: REFERER },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单个关键词的搜索。
 * @returns {Promise<{rows: object[]|null, error: string|null}>}
 *   成功：rows 为数组（可能为空）；失败：rows 为 null 并给出 error。
 */
async function searchOnce(keyword, pageSize) {
  let text;
  try {
    text = await getText(buildSearchUrl(keyword, pageSize));
  } catch (e) {
    return { rows: null, error: `search(${keyword}): ${e?.message || '请求失败'}` };
  }

  const json = parseJsonp(text);
  if (json === null) {
    return { rows: null, error: `search(${keyword}): JSONP 解析失败` };
  }

  const rows = json?.result?.cmsArticleWebOld;
  if (!Array.isArray(rows)) {
    // 接口显式报错（code !== 0）时按失败处理；只是没有结果则算成功但为空
    if (json?.code !== undefined && json.code !== 0) {
      const msg = json?.msg ? ` ${json.msg}` : '';
      return { rows: null, error: `search(${keyword}): 接口返回 code=${json.code}${msg}` };
    }
    return { rows: [], error: null };
  }
  return { rows, error: null };
}

/** 原始行 → 新闻条目；标题为空的行直接丢弃（不编造标题） */
function toNewsItem(row) {
  const title = cleanText(row?.title);
  if (!title) return null;
  const summary = truncateText(cleanText(row?.content), MAX_SUMMARY_CHARS);
  const keywords = matchPolicyKeywords(`${title} ${summary}`);
  return {
    date: typeof row?.date === 'string' ? row.date : null,
    title,
    summary,
    is_policy: keywords.length > 0,
    policy_keywords: keywords,
  };
}

/* ── 主入口 ─────────────────────────────────────────────── */

/**
 * 采集消息面 / 政策面新闻。
 *
 * 关键词策略（按优先级，各取一批后按 title 全局去重）：
 *   ① 公司名：facts.name
 *   ② 行业名：facts.sector.name（先去掉 Ⅱ/Ⅲ 等罗马数字后缀）
 *   ③ 政策组合：`<行业名> 政策`
 *
 * 任一关键词失败不影响其它关键词；所有失败都进 errors。
 *
 * @param {object} facts   gather() 产出（用 name / sector.name / symbol）
 * @param {{limit?:number, now?:Date}} [opts]
 * @returns {Promise<{
 *   ok:boolean, symbol:string, fetched_at:string,
 *   company_news:object[], industry_news:object[], policy_news:object[],
 *   sentiment:{positive:number,negative:number,neutral:number,policy_count:number}|null,
 *   errors:string[], sources:string[]
 * }>}
 */
export async function fetchNews(facts, { limit = DEFAULT_PAGE_SIZE, now = new Date() } = {}) {
  const fetched_at = nowShanghai(now);
  const symbol = typeof facts?.symbol === 'string' ? facts.symbol : String(facts?.symbol ?? '');
  const errors = [];

  const companyName = typeof facts?.name === 'string' ? facts.name.trim() : '';
  const sectorRaw = typeof facts?.sector === 'string' ? facts.sector : facts?.sector?.name;
  const sectorName = normalizeSectorName(sectorRaw);
  const pageSize = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  const queries = [];
  if (companyName) queries.push({ kind: 'company', keyword: companyName });
  if (sectorName && sectorName !== companyName) queries.push({ kind: 'industry', keyword: sectorName });
  // 注意：东财搜索对「<行业> 政策」是宽松匹配（近似 OR），会返回与行业无关的通用政策新闻。
  // 本模块按需求只做关键词命中，不做相关性过滤；policy_news 里可能混入无关政策，
  // 下游引用时必须自行核对标题/摘要内容。
  if (sectorName) queries.push({ kind: 'policy', keyword: `${sectorName} 政策` });

  const base = {
    ok: false,
    symbol,
    fetched_at,
    company_news: [],
    industry_news: [],
    policy_news: [],
    sentiment: null,
    errors,
    sources: [],
  };

  if (queries.length === 0) {
    errors.push('缺少公司名与行业名，无法检索新闻');
    return base;
  }

  // 三个关键词并行请求，互不影响
  const settled = await Promise.all(
    queries.map(async (q) => {
      const { rows, error } = await searchOnce(q.keyword, pageSize);
      return { ...q, rows, error };
    }),
  );
  for (const r of settled) if (r.error) errors.push(r.error);

  const successCount = settled.filter((r) => Array.isArray(r.rows)).length;
  const ok = successCount > 0;

  // 按 title 全局去重：优先级 company → industry → policy，先到先得
  const seen = new Set();
  const buckets = { company: [], industry: [], policy: [] };
  const all = [];
  for (const r of settled) {
    if (!Array.isArray(r.rows)) continue;
    for (const row of r.rows.slice(0, pageSize)) {
      const item = toNewsItem(row);
      if (!item) continue;
      if (seen.has(item.title)) continue;
      seen.add(item.title);
      buckets[r.kind].push(item);
      all.push(item);
    }
  }

  // 政策新闻：所有批次里命中政策关键词的合并去重（policy_news 不带 is_policy 字段）
  const policy_news = all
    .filter((item) => item.policy_keywords.length > 0)
    .slice(0, pageSize)
    .map(({ date, title, summary, policy_keywords }) => ({ date, title, summary, policy_keywords }));

  // 情绪粗分（词袋，不代表真实情绪）：按去重后的全部新闻逐条归类计数
  let sentiment = null;
  if (all.length > 0) {
    const counts = { positive: 0, negative: 0, neutral: 0 };
    for (const item of all) counts[classifySentiment(item.title, item.summary).label]++;
    sentiment = { ...counts, policy_count: policy_news.length };
  }

  return {
    ...base,
    ok,
    company_news: buckets.company,
    industry_news: buckets.industry,
    policy_news,
    sentiment,
    sources: ok ? [SOURCE] : [],
  };
}
