/**
 * 天市 · 技术指标（纯函数，无状态，null 安全）
 * 所有指标只用传入的 K 线计算，不引入任何外部数据。
 */

/** 简单移动平均，返回与输入等长的数组，前 n-1 位为 null */
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 指数移动平均 */
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 标准差（样本） */
export function stdev(values, n) {
  const out = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    const win = values.slice(i - n + 1, i + 1);
    const m = win.reduce((a, b) => a + b, 0) / n;
    const v = win.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
    out[i] = Math.sqrt(v);
  }
  return out;
}

/** RSI（Wilder） */
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (i <= n) {
      gain += g;
      loss += l;
      if (i === n) {
        gain /= n;
        loss /= n;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

/** MACD(12,26,9) → {dif, dea, hist} 等长数组 */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const dif = closes.map((_, i) => (ef[i] === null || es[i] === null ? null : ef[i] - es[i]));
  const difClean = dif.map((v) => (v === null ? 0 : v));
  const dea = ema(difClean, signal).map((v, i) => (dif[i] === null ? null : v));
  const hist = dif.map((v, i) => (v === null || dea[i] === null ? null : (v - dea[i]) * 2));
  return { dif, dea, hist };
}

/** 真实波幅 ATR（Wilder 平滑） */
export function atr(bars, n = 14) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 0; i < tr.length; i++) {
    if (i < n - 1) continue;
    if (i === n - 1) {
      prev = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    } else {
      prev = (prev * (n - 1) + tr[i]) / n;
    }
    out[i] = prev;
  }
  return out;
}

/** 布林带(20,2) */
export function boll(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const sd = stdev(closes, n);
  return {
    mid,
    upper: mid.map((m, i) => (m === null || sd[i] === null ? null : m + k * sd[i])),
    lower: mid.map((m, i) => (m === null || sd[i] === null ? null : m - k * sd[i])),
  };
}

/** 全量指标快照（最后一根） */
export function snapshot(bars) {
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume ?? 0);
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const a = atr(bars, 14);
  const b = boll(closes, 20, 2);
  const i = closes.length - 1;
  const vol20 = sma(vols, 20);
  const last = closes[i];
  const atrPct = a[i] === null || last === null ? null : (a[i] / last) * 100;

  return {
    close: last,
    ma5: ma5[i],
    ma10: ma10[i],
    ma20: ma20[i],
    ma60: ma60[i],
    rsi14: r[i],
    macd_dif: m.dif[i],
    macd_dea: m.dea[i],
    macd_hist: m.hist[i],
    atr14: a[i],
    atr_pct: atrPct,
    boll_mid: b.mid[i],
    boll_upper: b.upper[i],
    boll_lower: b.lower[i],
    vol: vols[i],
    vol_ma20: vol20[i],
    vol_ratio: vol20[i] ? vols[i] / vol20[i] : null,
    // 结构判定
    above_ma20: ma20[i] === null ? null : last > ma20[i],
    above_ma60: ma60[i] === null ? null : last > ma60[i],
    ma_alignment: ma5[i] !== null && ma20[i] !== null && ma60[i] !== null
      ? ma5[i] > ma20[i] && ma20[i] > ma60[i]
        ? 'bull'
        : ma5[i] < ma20[i] && ma20[i] < ma60[i]
          ? 'bear'
          : 'mixed'
      : null,
  };
}

/** 区间涨跌幅 */
export function pctChange(closes, from, to) {
  if (from < 0 || to >= closes.length || from >= to) return null;
  const a = closes[from];
  const b = closes[to];
  if (!a || !b) return null;
  return ((b - a) / a) * 100;
}

/**
 * 把当前"市场状态"编码成可匹配的签名。
 * 用于历史类比：找到历史上同状态的时刻，统计其后续真实表现。
 */
function encode(last, ma20, ma60, r, hist) {
  if (ma20 === null || ma60 === null || r === null) return null;
  const trend = last > ma20 && last > ma60 ? 'up' : last < ma20 && last < ma60 ? 'down' : 'side';
  const mom = r >= 70 ? 'hot' : r >= 55 ? 'warm' : r <= 30 ? 'cold' : r <= 45 ? 'cool' : 'neutral';
  const macdSign = (hist ?? 0) > 0 ? 'pos' : 'neg';
  return `${trend}|${mom}|${macdSign}`;
}

export function stateSignature(bars, idx) {
  const closes = bars.slice(0, idx + 1).map((b) => b.close);
  if (closes.length < 61) return null;
  return encode(closes.at(-1), sma(closes, 20).at(-1), sma(closes, 60).at(-1), rsi(closes, 14).at(-1), macd(closes).hist.at(-1));
}

/**
 * 一次性算好所有时点的状态签名（O(n)）。
 * 回测会对同一份 K 线反复取签名，逐索引重算是 O(n^2)：6000 根 × 45 个时点会卡死。
 */
export function signatureSeries(bars) {
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < 61) return out;
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const r = rsi(closes, 14);
  const h = macd(closes).hist;
  for (let i = 60; i < n; i++) out[i] = encode(closes[i], ma20[i], ma60[i], r[i], h[i]);
  return out;
}
