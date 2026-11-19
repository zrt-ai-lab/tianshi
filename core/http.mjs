/**
 * 天市 · HTTP 取数原语
 * 只做三件事：带上超时、拿回原始字节、永不吞错。
 */

import { execFile } from 'node:child_process';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** 东财 WAF 按 TLS 指纹拦截 Node 原生请求（实测 curl 可通、fetch/https/http2 全被 ECONNRESET）。
 *  所以对东财域名：fetch 失败后用系统 curl 重试一次。只对东财域名启用，不动其他来源。 */
function isEastmoneyHost(url) {
  try {
    return /(^|\.)eastmoney\.com$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** curl 兜底：只接受 http/https URL，避免把用户输入拼进 shell（参数数组形式，不经 shell 解释）。 */
function curlRaw(url, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-sS', '--compressed', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-A', UA, '-H', 'Referer: https://quote.eastmoney.com/', url],
      { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs + 2000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ ok: false, status: 0, buf: Buffer.alloc(0), error: 'curl: ' + String(err.message ?? err) });
        const buf = Buffer.from(stdout);
        resolve({ ok: buf.length > 0 && !err, status: buf.length ? 200 : 0, buf, error: err && !buf.length ? 'curl: ' + String(stderr || err.message) : null });
      },
    );
  });
}

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
    if (!aborted && isEastmoneyHost(url)) {
      const viaCurl = await curlRaw(url, timeoutMs);
      if (viaCurl.ok) return viaCurl;
      return { ok: false, status: 0, buf: Buffer.alloc(0), error: `fetch: ${String(e?.message ?? e)}；curl: ${viaCurl.error ?? '同样失败'}` };
    }
    const failed = aborted ? 'timeout' : String(e?.message ?? e);
    return { ok: false, status: 0, buf: Buffer.alloc(0), error: failed };
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

/** 东财接口间歇性空回复（实测约五成），重试 3 次可把成功率拉到九成以上。 */
const RETRY_HOST_RE = /eastmoney\.com/;
export async function emText(url, { timeoutMs = 12000, headers = {}, retries = 3 } = {}) {
  const attempts = RETRY_HOST_RE.test(url) ? Math.max(1, retries) : 1;
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const r = await fetchRaw(url, { timeoutMs, headers });
    if (r.ok && r.buf.length) return decode(r.buf);
    last = r;
    if (i + 1 < attempts) await new Promise((res) => setTimeout(res, 220 + i * 420));
  }
  throw new Error(last?.error || 'HTTP error');
}

/** 取 JSON：同上，解析失败抛错。 */
export async function emJson(url, { timeoutMs = 12000, headers = {} } = {}) {
  const text = await emText(url, { timeoutMs, headers });
  const j = tryJson(text);
  if (j === null) throw new Error('响应不是有效 JSON');
  return j;
}

/** 数字清洗：非法/空 → null（绝不返回 0 冒充真实值） */
export function num(v) {
  if (v === null || v === undefined || v === '' || v === '-' || v === '--') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}
