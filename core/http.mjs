/**
 * 天市 · HTTP 取数原语
 * 只做三件事：带上超时、拿回原始字节、永不吞错。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/**
 * @returns {Promise<{ok:boolean,status:number,buf:Buffer,error:string|null}>}
 */
export async function fetchRaw(url, { timeoutMs = 12000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Referer: 'https://quote.eastmoney.com/',
        ...headers,
      },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, buf, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, status: 0, buf: Buffer.alloc(0), error: aborted ? 'timeout' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 解码：GBK 用 TextDecoder('gbk')，其余 utf-8 */
export function decode(buf, encoding = 'utf-8') {
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 安全 JSON 解析，失败返回 null 而不是抛错 */
export function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 数字清洗：非法/空 → null（绝不返回 0 冒充真实值） */
export function num(v) {
  if (v === null || v === undefined || v === '' || v === '-' || v === '--') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}
