/** User-specified tracker: parse JSON snapshot only, never execute remote JS.
 * Reproduce the source's full-session close formula. No live/partial-day claim.
 */
const ORIGIN = 'https://etf-turnover-tracker.app.workbuddy.host';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function trackerSharecode() {
  const env = process.env.TIANSHI_TRACKER_SHARECODE;
  if (env && env.trim()) return env.trim();
  try {
    const dir = process.env.TIANSHI_ROOT || join(homedir(), '.dsh', 'tianshi-data');
    const config = JSON.parse(readFileSync(join(dir, 'tracker.json'), 'utf8'));
    return typeof config.sharecode === 'string' ? config.sharecode.trim() : '';
  } catch { return ''; }
}
export function parseTrackerSnapshot(text) {
  const match = String(text).match(/^\s*window\.SNAPSHOT\s*=\s*([\s\S]*?)\s*;?\s*$/);
  if (!match) throw new Error('来源没有返回有效数据快照');
  const snapshot = JSON.parse(match[1]);
  if (!Array.isArray(snapshot.items) || !/^\d{8}$/.test(snapshot.trade_date)) throw new Error('来源快照格式不匹配');
  return snapshot;
}
export function calculateTrackerClose(snapshot) {
  const items = snapshot.items.filter(x => x.group === 'core');
  if (!items.length) throw new Error('来源重点ETF池为空');
  let amount = 0, baseline = 0, net = 0;
  for (const x of items) {
    if (![x.amount_yi, x.avg20_yi, x.outer_lots, x.inner_lots].every(Number.isFinite) || x.avg20_yi <= 0) throw new Error('重点ETF数据缺失，不能生成结论');
    if (x.date !== snapshot.trade_date) throw new Error('重点ETF日期不一致，不能混日计算');
    amount += x.amount_yi; baseline += x.avg20_yi;
    const lots = x.outer_lots + x.inner_lots;
    net += lots > 0 ? (x.outer_lots - x.inner_lots) / lots * x.amount_yi : 0;
  }
  const ratio = amount / baseline;
  let title;
  if (ratio >= 1.8 && net > 0) title = '大概率上班了';
  else if (ratio >= 1.3 && net > 0) title = '有护盘迹象';
  else if (ratio >= 1.8 && net <= 0) title = '放量了，方向不对';
  else if (ratio >= 1.3) title = '成交活跃，证据不够';
  else title = '没看出上班迹象';
  const round = n => Number(n.toFixed(3));
  return { ok: true, title, trade_date: snapshot.trade_date, generated_at: snapshot.generated_at,
    count: items.length, amount_yi: round(amount), baseline_yi: round(baseline), ratio: round(ratio), active_net_yi: round(net),
    method: '原站收盘口径复算：重点ETF池成交额合计 ÷ 20日均额合计；主动净买入按(外盘−内盘)/(外盘+内盘)×成交额逐只加总。',
    boundary: '仅为该日期的收盘量价推测，不证明国家队实际交易；主动净买入不等于资金净流入或基金申赎。',
    source: '用户指定的汪汪队ETF跟踪器', mode: 'source_close_snapshot',
    items: items.map(x => ({ code: x.code, name: x.name, amount_yi: x.amount_yi, avg20_yi: x.avg20_yi, date: x.date })) };
}
export async function fetchTrackerClose() {
  const share = trackerSharecode();
  if (!share) throw new Error('ETF跟踪器未配置：请由安装者提供自己的分享码（tracker.json 或 TIANSHI_TRACKER_SHARECODE）');
  const SHARE = encodeURIComponent(share);
  const landing = await fetch(ORIGIN + '/?sharecode=' + SHARE, { signal: AbortSignal.timeout(12000) });
  if (!landing.ok) throw new Error('来源页面不可用 HTTP ' + landing.status);
  const cookies = typeof landing.headers.getSetCookie === 'function' ? landing.headers.getSetCookie() : [landing.headers.get('set-cookie') || ''];
  const cookie = cookies.map(x => x.split(';')[0]).filter(Boolean).join('; ');
  await landing.text();
  const response = await fetch(ORIGIN + '/data/snapshot.js?sharecode=' + SHARE + '&t=' + Date.now(), {
    signal: AbortSignal.timeout(12000), headers: { Cookie: cookie, Referer: ORIGIN + '/?sharecode=' + SHARE } });
  if (!response.ok) throw new Error('来源数据不可用 HTTP ' + response.status);
  const snapshot = parseTrackerSnapshot(await response.text());
  const codes = snapshot.items.map(x => x.tcode).filter(x => /^(sh|sz)\d{6}$/.test(x));
  try {
    const live = await fetch('https://qt.gtimg.cn/q=' + codes.join(','), { signal: AbortSignal.timeout(8000) });
    if (!live.ok) throw new Error('腾讯行情 HTTP ' + live.status);
    const text = new TextDecoder('gb18030').decode(await live.arrayBuffer());
    return mergeTrackerLive(snapshot, text);
  } catch (e) {
    return { ...calculateTrackerClose(snapshot), live_error: String(e.message || e), freshness: 'historical_fallback' };
  }
}

/** Parse only numeric quote fields; do not execute Tencent response JavaScript. */
export function mergeTrackerLive(snapshot, text) {
  const quotes = new Map();
  for (const match of text.matchAll(/v_(?:sh|sz)\d{6}="([^"\n]+)"/g)) {
    const a = match[1].split('~');
    const numeric = i => a[i] !== '' && Number.isFinite(Number(a[i])) ? Number(a[i]) : null;
    if (a.length < 40 || !/^\d{14}$/.test(a[30] || '')) continue;
    if ([numeric(37), numeric(7), numeric(8)].some(x => x === null)) continue;
    quotes.set(a[2], { amount_yi: numeric(37) / 10000, outer_lots: numeric(7), inner_lots: numeric(8), date: a[30].slice(0, 8), ts: a[30] });
  }
  const core = snapshot.items.filter(x => x.group === 'core');
  if (!core.every(x => quotes.has(x.code))) throw new Error('实时重点ETF不完整，不能混合历史快照');
  const dates = new Set(core.map(x => quotes.get(x.code).date));
  if (dates.size !== 1) throw new Error('实时ETF交易日不一致');
  const date = [...dates][0];
  const ts = core.map(x => quotes.get(x.code).ts).sort()[0];
  const hhmm = ts.slice(8, 10) + ':' + ts.slice(10, 12);
  const minute = Number(ts.slice(8, 10)) * 60 + Number(ts.slice(10, 12));
  if (minute < 570) throw new Error('尚未开盘，不能用零成交生成结论');
  const partial = minute < 900;
  const effective = minute >= 690 && minute < 780 ? '11:30' : hhmm;
  const items = snapshot.items.map(x => {
    if (x.group !== 'core') return x;
    const q = quotes.get(x.code);
    const progress = partial ? trackerShapeAt(x.shape, effective) : 1;
    if (!(progress > 0)) throw new Error(x.code + '缺少同时点成交进度');
    return { ...x, ...q, avg20_yi: x.avg20_yi * progress };
  });
  const out = calculateTrackerClose({ ...snapshot, trade_date: date, items });
  return { ...out, mode: partial ? 'source_live_aligned' : 'source_live_close', freshness: 'quotes_updated',
    quote_time: ts, baseline_generated_at: snapshot.generated_at, baseline_trade_date: snapshot.trade_date,
    method: '原站ETF池及历史基准 + 腾讯最新行情；' + (partial ? '分母按原站历史日内成交曲线对齐到' + effective : '收盘成交额与全天20日均额对比') + '；主动净买入按外内盘差额比例逐只计算。',
    boundary: '行情已更新；历史基准生成于' + snapshot.generated_at + '，基准可能滞后。量价信号不能确认国家队交易身份。主动净买入不等于净流入或申赎。' };
}
export function trackerShapeAt(shape, hhmm) {
  if (!Array.isArray(shape) || !shape.length) return null;
  const minutes = t => { const p = t.split(':').map(Number); return p[0] * 60 + p[1]; };
  const target = minutes(hhmm);
  if (target <= minutes(shape[0][0])) return shape[0][1];
  for (let i = 1; i < shape.length; i++) {
    const right = minutes(shape[i][0]), left = minutes(shape[i - 1][0]);
    if (target <= right) return shape[i - 1][1] + (shape[i][1] - shape[i - 1][1]) * (target - left) / (right - left);
  }
  return shape[shape.length - 1][1];
}
