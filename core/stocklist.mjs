/**
 * 全市场股票名录：搜索的兜底数据源
 *
 * 为什么需要它：东财 suggest 接口的 `Classify` 字段对 A 股并不统一——
 *   沪A/深A 返回 'AStock'，科创板返回数字 '23'，北交所返回 'NEEQ'。
 *   只按 'AStock' 过滤会把科创板和北交所全部漏掉（线上真实 bug）。
 * 所以这里额外拉一份全市场名录，在 suggest 结果不足时做本地模糊匹配兜底。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

let cache = { at: 0, items: [] };
const TTL_MS = 30 * 60 * 1000;

/** 拉取全 A 股名录（约 5500 只） */
export async function fetchAllStocks() {
  if (cache.items.length && Date.now() - cache.at < TTL_MS) return cache.items;
  const fs = [
    'm:0+t:6', 'm:0+t:80', 'm:1+t:2', 'm:1+t:23', // 深A/创业板/沪A/科创板
    'm:0+t:81+s:2048', // 北交所
  ].join(',');
  const PAGE = 100;

  async function page(pn) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(
        `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${PAGE}&po=1&np=1&fltt=2&invt=2&fid=f3` +
        `&fs=${encodeURIComponent(fs)}&fields=f12,f14`,
        { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return { rows: j?.data?.diff ?? [], total: Number(j?.data?.total) || 0 };
    } finally { clearTimeout(timer); }
  }

  const items = [];
  try {
    const first = await page(1);
    const total = first.total || 0;
    const pages = Math.min(70, Math.max(1, Math.ceil(total / PAGE)));
    const collect = (rows) => {
      for (const r of rows) {
        const code = String(r.f12 ?? '');
        const name = String(r.f14 ?? '');
        if (!/^\d{6}$/.test(code) || !name) continue;
        items.push({ code, name });
      }
    };
    collect(first.rows);
    for (let start = 2; start <= pages; start += 6) {
      const batch = [];
      for (let pn = start; pn < start + 6 && pn <= pages; pn++) batch.push(page(pn).catch(() => ({ rows: [] })));
      const results = await Promise.all(batch);
      results.forEach((r) => collect(r.rows));
    }
  } catch {
    return cache.items;
  }
  if (items.length) cache = { at: Date.now(), items };
  return items.length ? items : cache.items;
}

/** 简易拼音首字母错误容忍：只做名称与代码的包含匹配 */
export function localSearch(all, keyword, limit = 12) {
  const q = String(keyword ?? '').trim().toLowerCase();
  if (!q) return [];
  const exact = [];
  const prefix = [];
  const contains = [];
  for (const s of all) {
    const code = s.code;
    const name = s.name;
    const lowerName = name.toLowerCase();
    if (code === q) { exact.push(s); continue; }
    if (code.startsWith(q) || lowerName.startsWith(q)) { prefix.push(s); continue; }
    if (lowerName.includes(q) || code.includes(q)) contains.push(s);
    if (prefix.length + contains.length + exact.length >= limit * 4) continue;
  }
  return [...exact, ...prefix, ...contains].slice(0, limit);
}
