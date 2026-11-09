/**
 * 股吧舆情：抓东方财富股吧的网友帖子，做热度、情绪与代表性观点统计
 *
 * 数据边界（重要）：
 *   1. 只抓**东方财富股吧**。雪球（WAF 拦截）、同花顺（无公开接口）当前抓不到，
 *      不做伪装，界面上直接说明只有东财股吧一个来源。
 *   2. 帖子是网友个人观点，**不代表事实**。本模块只做汇总统计与原文摘录，不改写、不代言。
 *   3. 情绪是词袋粗分（数关键词），不是语义判断，仅供参考。
 *   4. 展示只保留标题与摘要片段，指向原帖，不复制全文。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

const POSITIVE = ['上涨', '涨停', '利好', '突破', '新高', '买入', '加仓', '看好', '起飞', '爆发', '牛', '翻倍', '回本', '反弹', '机会', '强势', '抄底', '补仓'];
const NEGATIVE = ['下跌', '跌停', '利空', '暴跌', '亏', '割肉', '套牢', '减仓', '清仓', '跑', '崩', '垃圾', '退市', '风险', '出货', '砸盘', '阴跌', '被套'];

/** 从股吧 HTML 里解析出帖子列表 */
export function parseGubaHtml(html) {
  const idx = html.indexOf('var article_list=');
  if (idx < 0) return [];
  const raw = html.slice(idx + 'var article_list='.length);
  // 找到 JSON 结束位置：逐个尝试 raw_decode 的等价实现
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return [];
  let obj;
  try { obj = JSON.parse(raw.slice(0, end)); } catch { return []; }
  const list = obj?.re ?? [];
  return list.map((it) => {
    const title = String(it.post_title ?? '').trim();
    const content = String(it.post_content ?? it.post_abstract ?? '').replace(/\s+/g, ' ').trim();
    const text = (title || content).slice(0, 60);
    if (!text) return null;
    return {
      id: it.post_id ?? null,
      title: title.slice(0, 80) || content.slice(0, 60),
      snippet: content.slice(0, 120),
      time: it.post_publish_time ?? it.post_display_time ?? null,
      clicks: Number(it.post_click_count) || 0,
      comments: Number(it.post_comment_count) || 0,
      likes: Number(it.post_like_count) || 0,
      author: it.post_user?.user_nickname ?? null,
      is_hot: Boolean(it.post_is_hot),
      url: it.post_id ? `https://guba.eastmoney.com/news,${it.post_guba?.stockbar_code ?? ''},${it.post_id}.html` : null,
    };
  }).filter(Boolean);
}

/** 抓股吧帖子（多页合并） */
export async function fetchGubaPosts(symbol, pages = 2) {
  const code = String(symbol ?? '').replace(/^(sh|sz|bj)/i, '');
  if (!/^\d{6}$/.test(code)) return { ok: false, posts: [], error: 'invalid symbol' };
  const all = [];
  const errors = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const url = p === 1 ? `https://guba.eastmoney.com/list,${code}.html` : `https://guba.eastmoney.com/list,${code},f_${p}.html`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      let text;
      try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://guba.eastmoney.com/' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      } finally { clearTimeout(timer); }
      const posts = parseGubaHtml(text);
      if (!posts.length) { errors.push(`第 ${p} 页无数据`); continue; }
      all.push(...posts);
    } catch (e) {
      errors.push(`第 ${p} 页：${String(e?.message ?? e)}`);
    }
  }
  const seen = new Set();
  const uniq = [];
  for (const p of all) {
    const key = p.id || p.title;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(p);
  }
  return { ok: uniq.length > 0, posts: uniq, errors };
}

/** 词袋情绪 */
export function classifyPost(text) {
  const t = String(text ?? '');
  let pos = 0;
  let neg = 0;
  const hits = [];
  for (const w of POSITIVE) if (t.includes(w)) { pos++; hits.push(w); }
  for (const w of NEGATIVE) if (t.includes(w)) { neg++; hits.push(w); }
  const label = pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
  return { label, pos, neg, hits };
}

/** 高频词（简单 2-4 字中文词提取，用停用词过滤） */
const STOP = new Set(['股票', '今天', '明天', '我们', '你们', '他们', '这个', '那个', '还是', '已经', '可以', '就是', '没有', '什么', '怎么', '为什么', '长江', '电力', '股份', '公司', '一下', '大家', '自己', '不是', '这种', '一个', '现在', '时候', '开始', '继续', '觉得', '认为']);
export function topKeywords(posts, limit = 12) {
  const freq = new Map();
  for (const p of posts) {
    const text = String((p.title ?? '') + ' ' + (p.snippet ?? ''));
    const grams = text.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [];
    for (const g of grams) {
      if (STOP.has(g)) continue;
      freq.set(g, (freq.get(g) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, n]) => ({ word, n }));
}

/**
 * 汇总分析
 * @returns {{ok:boolean, heat:object, sentiment:object, keywords:Array, voices:Array, caveats:string[]}}
 */
export function analyzeSentiment(posts, errors = []) {
  const list = posts ?? [];
  if (!list.length) {
    return { ok: false, heat: null, sentiment: null, keywords: [], voices: [], caveats: ['股吧没有抓到帖子'], errors };
  }
  const totalClicks = list.reduce((a, p) => a + p.clicks, 0);
  const totalComments = list.reduce((a, p) => a + p.comments, 0);

  const labels = { positive: 0, negative: 0, neutral: 0 };
  for (const p of list) labels[classifyPost(p.title + ' ' + p.snippet).label]++;
  const total = list.length;
  const posPct = (labels.positive / total) * 100;
  const negPct = (labels.negative / total) * 100;

  // 热度分级（基于阅读量中位数）
  const clicksSorted = list.map((p) => p.clicks).sort((a, b) => a - b);
  const median = clicksSorted[Math.floor(clicksSorted.length / 2)] ?? 0;

  // 代表性观点：按阅读量取前 6
  const voices = list
    .slice()
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 6)
    .map((p) => ({ title: p.title, snippet: p.snippet, clicks: p.clicks, comments: p.comments, time: p.time }));

  const caveats = [
    '帖子是网友个人观点，不代表事实，也不构成投资建议',
    '情绪为词袋粗分（数关键词），不是语义理解',
    '当前只接入东方财富股吧；雪球被 WAF 拦截、同花顺无公开接口，均未接入',
  ];
  if (errors.length) caveats.push('部分页面抓取失败：' + errors.join('；'));

  return {
    ok: true,
    heat: {
      posts: total,
      total_clicks: totalClicks,
      total_comments: totalComments,
      median_clicks: median,
      hot_posts: list.filter((p) => p.is_hot).length,
      level: totalClicks > 50000 ? '很热' : totalClicks > 10000 ? '中等' : '偏冷',
    },
    sentiment: {
      positive: labels.positive,
      negative: labels.negative,
      neutral: labels.neutral,
      pos_pct: Number(posPct.toFixed(1)),
      neg_pct: Number(negPct.toFixed(1)),
      diverge: Math.min(posPct, negPct) > 25 ? '分歧大' : posPct > negPct * 2 ? '偏多' : negPct > posPct * 2 ? '偏空' : '分歧一般',
    },
    keywords: topKeywords(list),
    voices,
    caveats,
    errors,
  };
}
