/** Public notice/concept evidence, not inferred trader identity or regulatory expiry. */
const cache = new Map();
async function json(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return j;
}
export function classifyRegulatoryNotice(title) {
  const t = String(title || '');
  if (/停牌|复牌/.test(t)) return '停复牌公告';
  if (/严重异常波动|严重异动/.test(t)) return '严重异动公告';
  if (/股票交易.*异常波动|股票.*异动/.test(t)) return '交易异动公告';
  if (/监管函|问询函|关注函|重点监控|重点监测/.test(t)) return '监管相关公告';
  if (/股票交易.*风险提示|股票.*风险提示/.test(t)) return '交易风险提示';
  return null;
}
export function summarizeRegulatory(notices, now = new Date()) {
  const since = now.getTime() - 120 * 86400000;
  const matched = notices.filter(n => {
    const time = Date.parse(String(n.notice_date || '').slice(0,10) + 'T00:00:00+08:00');
    return time >= since && time <= now.getTime() && classifyRegulatoryNotice(n.title);
  }).map(n => ({ date: String(n.notice_date).slice(0,10), title: n.title, kind: classifyRegulatoryNotice(n.title), url: /^AN\d+$/.test(n.art_code || '') ? 'https://data.eastmoney.com/notices/detail/' + n.symbol + '/' + n.art_code + '.html' : null }));
  return {
    notices: matched, expiry: null, monitoring_confirmed: false,
    status: matched.length ? '查到相关公告，具体监管状态待核实' : '近期所取公告中未发现相关标题',
    caveat: '仅检索最近100条公告标题及近120天记录；异动公告不等于重点监控，未找到也不代表未被监管。未读取公告正文，不推算监管结束日期。',
    scenarios: [
      '横盘缩量、换手下降可能体现交易降温，也可能是需求减弱；不能据此认定主力刻意压价。',
      '若后续出现公开的监管状态更新，再结合放量突破、板块回暖与承接判断二波；所谓“出监管”不是自动买点。',
      '若放量下跌、跌破整理区间或同题材走弱，应优先考虑退潮情景，而不是用规避监管解释一切。'
    ]
  };
}
export async function fetchRegulatory(symbol) {
  const key = 'notice:' + symbol, hit = cache.get(key);
  if (hit && Date.now()-hit.at < 300000) return hit.value;
  const j = await json('https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=100&page_index=1&ann_type=A&client_source=web&stock_list=' + symbol);
  if (!Array.isArray(j?.data?.list)) throw new Error('公告来源未返回有效列表');
  const result = { ok: true, symbol, source: '东方财富公告列表', ...summarizeRegulatory(j.data.list.map(n=>({...n,symbol}))) };
  cache.set(key,{at:Date.now(),value:result}); return result;
}
export async function fetchConceptMembership(symbol) {
  const key = 'concept:' + symbol, hit = cache.get(key);
  if (hit && Date.now()-hit.at < 1800000) return hit.value;
  const exchange = /^(6|9)/.test(symbol) ? 'SH' : /^(43|82|83|87|88|92)/.test(symbol) ? 'BJ' : 'SZ';
  const j = await json('https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_CORETHEME_BOARDTYPE&columns=BOARD_NAME&filter=' + encodeURIComponent('(SECUCODE="' + symbol + '.' + exchange + '")') + '&pageNumber=1&pageSize=100&source=HSF10&client=PC');
  if (!Array.isArray(j?.result?.data)) throw new Error('概念归属数据缺失');
  const value = [...new Set(j.result.data.map(x=>x.BOARD_NAME).filter(x=>typeof x==='string'&&x))];
  cache.set(key,{at:Date.now(),value});return value;
}
