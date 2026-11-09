/**
 * 天市 · 腾讯行情源（qt.gtimg.cn）
 *
 * 用途：实时快照。作为「双源交叉」的第一路。
 * 编码：GBK —— 原始 buffer 落盘，解析时才转码。
 *
 * 字段位（2026-11 实测 sh600519 校准过）：
 *  [1] 名称 [2] 代码 [3] 现价 [4] 昨收 [5] 今开 [6] 成交量(手)
 *  [30] 时间 YYYYMMDDHHMMSS [31] 涨跌额 [32] 涨跌幅% [33] 最高 [34] 最低
 *  [37] 成交额(万元) [38] 换手率% [39] 市盈率TTM [43] 振幅%
 *  [44] 总市值(亿) [45] 流通市值(亿) [46] 市净率
 */

import { fetchRaw, decode, num } from '../http.mjs';
import { makeEvidence, saveRaw, evidenceId, nowShanghai, compactDate } from '../provenance.mjs';

const SOURCE = 'tencent';
const BASE = 'https://qt.gtimg.cn/q=';

/** 600519 -> sh600519 */
export function withPrefix(code) {
  const c = String(code).replace(/^(sh|sz|bj)/i, '');
  if (/^(6)/.test(c)) return `sh${c}`;
  if (/^(0|3)/.test(c)) return `sz${c}`;
  if (/^(4|8|9)/.test(c)) return `bj${c}`;
  return `sh${c}`;
}

function pick(f, i) {
  const v = f[i];
  return v === undefined ? null : v;
}

/**
 * 取单只股票实时快照。
 * @returns {Promise<{quote: object|null, evidence: object}>}
 */
export async function fetchQuote(code, { rootDir = '.', now = new Date() } = {}) {
  const sym = withPrefix(code);
  const url = `${BASE}${sym}`;
  const eid = evidenceId(String(code).replace(/^(sh|sz|bj)/i, ''), SOURCE, 'quote', now);
  const r = await fetchRaw(url);

  const relPath = `evidence/${compactDate(now)}/${code}/${SOURCE}_quote.txt`;
  const saved = r.buf.length ? saveRaw(r.buf, relPath, rootDir) : { raw_path: relPath, raw_sha256: '' };

  const evidence = makeEvidence({
    evidence_id: eid,
    source: SOURCE,
    endpoint: url,
    fetched_at: nowShanghai(now),
    raw_sha256: saved.raw_sha256,
    raw_path: saved.raw_path,
    encoding: 'gbk',
    ok: r.ok && r.buf.length > 0,
    error: r.error,
  });

  if (!evidence.ok) return { quote: null, evidence };

  const text = decode(r.buf, 'gbk');
  const m = text.match(/="([^"]*)"/);
  if (!m) return { quote: null, evidence: { ...evidence, ok: false, error: 'unexpected payload' } };

  const f = m[1].split('~');
  const price = num(pick(f, 3));
  if (price === null) return { quote: null, evidence: { ...evidence, ok: false, error: 'no price field' } };

  const volumeLots = num(pick(f, 6));
  const amountWan = num(pick(f, 37));

  const quote = {
    price,
    open: num(pick(f, 5)),
    high: num(pick(f, 33)),
    low: num(pick(f, 34)),
    prev_close: num(pick(f, 4)),
    pct_chg: num(pick(f, 32)),
    volume: volumeLots === null ? null : volumeLots * 100, // 手 -> 股
    amount: amountWan === null ? null : amountWan * 10_000, // 万元 -> 元
    turnover_rate: num(pick(f, 38)),
    pe_ttm: num(pick(f, 39)),
    pb: num(pick(f, 46)),
    amplitude: num(pick(f, 43)),
    name: (pick(f, 1) || '').replace(/\s+/g, '') || null,
    quote_time: pick(f, 30) || null, // YYYYMMDDHHMMSS
    evidence_id: eid,
  };

  return { quote, evidence };
}
