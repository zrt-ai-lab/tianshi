/**
 * 板块轮动与资金暗线
 *
 * 回答首页最该回答的问题：今天市场的钱往哪走、哪些方向在轮动。
 *
 * 数据：东方财富行业板块（m:90+t:2）与概念板块（m:90+t:3）全量列表，单次请求含
 *   今日 f3 / 5 日 f109 / 10 日 f160 / 60 日 f24 涨跌幅，
 *   今日 f62、5 日 f164、10 日 f174 主力净额及占成交比 f184 / f165 / f175，
 *   上涨 f104 / 下跌 f105 家数，领涨股 f128 / f140
 *
 * 轮动四象限（横截面去中位数，避免大盘整体涨跌把所有板块都归到一边）：
 *   x60 = 60 日涨跌 − 全部板块中位数；x5 = 5 日涨跌 − 中位数
 *   持续强势  x60 ≥ +8 且 x5 ≥ 0      中期领先、短期没掉队
 *   高位回落  x60 ≥ +8 且 x5 ≤ −2     中期涨多了、短期在退
 *   超跌反弹  x60 ≤ −8 且 x5 ≥ +2     中期跌多了、短期在弹（如科技暴跌后的反弹）
 *   持续弱势  x60 ≤ −8 且 x5 ≤ 0      中期弱、短期也没起色
 *
 * 资金暗线（价格与资金的背离，往往比涨跌本身更早）：
 *   资金先行  5 日主力净流入占成交 ≥ 2%，但 5 日涨幅低于中位数——钱进来了，价格还没动
 *   拉高派发  5 日涨幅排前 20%，但 5 日主力净流出——涨了，大单在卖
 *
 * 这是现状描述，不是预测：象限会切换，背离也可能被价格「修正」而不是兑现。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const FIELDS = 'f12,f14,f3,f109,f160,f24,f62,f184,f164,f165,f174,f175,f104,f105,f128,f140';

/** 概念板块里不代表「题材方向」的指数类、风格类、事件类，排除 */
const NOISE_CONCEPTS = [
  '融资融券', '沪股通', '深股通', 'MSCI', 'HS300', '上证', '深成', '中证', '创业板综', '标准普尔', '富时罗素',
  '基金重仓', '社保重仓', 'QFII', '证金', '机构重仓', '茅指数', '宁组合', '昨日', '涨停', '连板', '首板', '炸板',
  '预盈预增', '预亏预减', '破净', '低价股', '高送转', '送转', '股权激励', 'AH股', 'AB股', 'B股', 'GDR', '次新',
  '注册制', '转债', '央视50', '百元股', 'ST股', '退市', '专精特新', '养老金', '参股', '举牌', '贬值受益', '内贸流通',
  '东方财富热股', '题材股', '热股', '标普', '同花顺', '举牌', '摘帽', '壳资源', '股权转让', '长线', '举牌股',
];

async function getPage(fs, pn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(
      `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=${FIELDS}`,
      { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } },
    );
    const j = await r.json();
    return { rows: j?.data?.diff ?? [], total: Number(j?.data?.total) || 0 };
  } finally { clearTimeout(timer); }
}

async function fetchList(fs) {
  const first = await getPage(fs, 1);
  const pages = Math.min(8, Math.ceil(first.total / 100));
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => getPage(fs, i + 2).catch(() => ({ rows: [] }))));
  return [first, ...rest].flatMap((x) => x.rows);
}

const num = (v) => (isNum(v) ? v : (typeof v === 'string' && v !== '-' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null));

export function normalizeBoard(x, kind) {
  return {
    code: String(x.f12 ?? ''), name: String(x.f14 ?? ''), kind,
    r1: num(x.f3), r5: num(x.f109), r10: num(x.f160), r60: num(x.f24),
    main1: num(x.f62), main1_ratio: num(x.f184),
    main5: num(x.f164), main5_ratio: num(x.f165),
    main10: num(x.f174), main10_ratio: num(x.f175),
    up: num(x.f104), down: num(x.f105),
    leader: x.f128 ? { name: String(x.f128), code: String(x.f140 ?? '') } : null,
  };
}

/**
 * 行业板块有 Ⅰ/Ⅱ/Ⅲ 多级，同一子行业在不同级别数据完全相同（如 焦炭Ⅱ / 焦炭Ⅲ）。
 * 按「今日涨跌 + 60 日涨跌 + 今日主力净额」去重，保留名称最短的一个，并去掉级别后缀。
 */
export function dedupeIndustry(list) {
  const map = new Map();
  for (const b of list) {
    const key = `${b.r1}|${b.r60}|${b.main1}`;
    const prev = map.get(key);
    if (!prev || b.name.length < prev.name.length) map.set(key, b);
  }
  return [...map.values()].map((b) => ({ ...b, name: b.name.replace(/[ⅠⅡⅢ]$/u, '') }));
}

export function isNoiseConcept(name) {
  return NOISE_CONCEPTS.some((k) => name.includes(k));
}

function median(arr) {
  const a = arr.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export const QUADRANTS = {
  strong: { key: 'strong', name: '持续强势', mean: '中期领先、短期没有掉队', act: '主线在这里，回调是机会，不追高' },
  fading: { key: 'fading', name: '高位回落', mean: '中期涨多了、短期开始退', act: '获利盘在兑现，别在这里接力' },
  rebound: { key: 'rebound', name: '超跌反弹', mean: '中期跌多了、短期在反弹', act: '先当反弹看：放量站稳 20 日线前不重仓' },
  weak: { key: 'weak', name: '持续弱势', mean: '中期弱、短期也没起色', act: '没有资金回流的信号前不碰' },
};

/** 把板块归入四象限，并给出资金暗线 */
export function analyzeRotation(boards, opts = {}) {
  const { top = 6 } = opts;
  const valid = boards.filter((b) => isNum(b.r5) && isNum(b.r60));
  const m5 = median(valid.map((b) => b.r5));
  const m60 = median(valid.map((b) => b.r60));
  const m1 = median(valid.map((b) => b.r1));
  const quad = { strong: [], fading: [], rebound: [], weak: [] };
  for (const b of valid) {
    const x60 = b.r60 - m60, x5 = b.r5 - m5;
    let q = null;
    if (x60 >= 8 && x5 >= 0) q = 'strong';
    else if (x60 >= 8 && x5 <= -2) q = 'fading';
    else if (x60 <= -8 && x5 >= 2) q = 'rebound';
    else if (x60 <= -8 && x5 <= 0) q = 'weak';
    if (q) quad[q].push({ ...b, x5: Number(x5.toFixed(2)), x60: Number(x60.toFixed(2)) });
  }
  // 象限内排序：强势按 5 日、回落按 5 日跌幅、反弹按 5 日反弹幅度、弱势按 60 日跌幅
  quad.strong.sort((a, b) => b.r5 - a.r5);
  quad.fading.sort((a, b) => a.r5 - b.r5);
  quad.rebound.sort((a, b) => b.r5 - a.r5);
  quad.weak.sort((a, b) => a.r60 - b.r60);

  // 资金暗线
  const withMain = valid.filter((b) => isNum(b.main5) && isNum(b.main5_ratio));
  const r5Sorted = withMain.map((b) => b.r5).sort((a, b) => a - b);
  const p80 = r5Sorted.length ? r5Sorted[Math.floor(r5Sorted.length * 0.8)] : Infinity;
  const leadMoney = withMain.filter((b) => b.main5_ratio >= 2 && b.r5 < m5).sort((a, b) => b.main5_ratio - a.main5_ratio);
  const distribute = withMain.filter((b) => b.r5 >= p80 && b.main5 < 0).sort((a, b) => a.main5 - b.main5);
  const inflow = withMain.slice().sort((a, b) => b.main5 - a.main5);
  const outflow = withMain.slice().sort((a, b) => a.main5 - b.main5);
  const todayTop = valid.slice().sort((a, b) => (b.r1 ?? -99) - (a.r1 ?? -99));

  const pick = (arr) => arr.slice(0, top);
  return {
    medians: { r1: Number(m1.toFixed(2)), r5: Number(m5.toFixed(2)), r60: Number(m60.toFixed(2)) },
    count: valid.length,
    quadrants: Object.fromEntries(Object.entries(quad).map(([k, v]) => [k, { ...QUADRANTS[k], count: v.length, items: pick(v) }])),
    money: {
      lead: { name: '资金先行', mean: '5 日主力净流入占成交 ≥2%，但 5 日涨幅低于中位数：钱进来了，价格还没动', count: leadMoney.length, items: pick(leadMoney) },
      distribute: { name: '拉高派发', mean: '5 日涨幅排前 20%，但 5 日主力净流出：涨了，大单在卖', count: distribute.length, items: pick(distribute) },
      inflow: pick(inflow), outflow: pick(outflow),
    },
    today: { top: pick(todayTop), bottom: pick(todayTop.slice().reverse()) },
  };
}

/** 一句话概括：给首页标题和 AI 用 */
export function summarizeRotation(ind, con) {
  const parts = [];
  const name = (x) => x.items.slice(0, 3).map((b) => b.name).join('、');
  if (ind.quadrants.rebound.count) parts.push(`超跌反弹：${name(ind.quadrants.rebound)}`);
  if (ind.quadrants.strong.count) parts.push(`持续强势：${name(ind.quadrants.strong)}`);
  if (ind.quadrants.fading.count) parts.push(`高位回落：${name(ind.quadrants.fading)}`);
  if (ind.money.lead.count) parts.push(`资金先行：${ind.money.lead.items.slice(0, 3).map((b) => b.name).join('、')}`);
  const hot = con?.today?.top?.slice(0, 3).map((b) => b.name).join('、');
  if (hot) parts.push(`今日最强概念：${hot}`);
  return parts.join('；');
}

/** 拉取并分析行业 + 概念 */
export async function fetchRotation() {
  const [indRaw, conRaw] = await Promise.all([fetchList('m:90+t:2'), fetchList('m:90+t:3')]);
  const industry = dedupeIndustry(indRaw.map((x) => normalizeBoard(x, 'industry')));
  const concept = conRaw.map((x) => normalizeBoard(x, 'concept')).filter((b) => !isNoiseConcept(b.name));
  const ind = analyzeRotation(industry);
  const con = analyzeRotation(concept);
  return {
    ok: industry.length > 0,
    at: new Date().toISOString(),
    industry: ind,
    concept: con,
    summary: summarizeRotation(ind, con),
    method: '四象限按 60 日与 5 日涨跌减去全部板块中位数划分（±8 / ±2 个百分点）；资金为东方财富按单笔金额划分的主力净额',
  };
}
