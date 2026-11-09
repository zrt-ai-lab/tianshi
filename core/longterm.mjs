/**
 * 长线适配度：判断一只票「适不适合长线拿」
 *
 * 用长江电力作为参照系：高分红、现金流稳定、波动小、长期趋势向上。
 *
 * 重要边界：
 *   1. 这是**风格识别**，不是「推荐买入」。识别的是「它像不像长牛股」，不是「它会不会涨」。
 *   2. 分红数据来自东财分红送配表，只统计已实施/已完成的方案。
 *   3. 波动率、回撤用 250 个交易日真实 K 线计算。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

async function getJson(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/** 分红历史 */
export async function fetchDividends(symbol) {
  try {
    const j = await getJson(
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL` +
      `&filter=(SECURITY_CODE%3D%22${encodeURIComponent(symbol)}%22)&pageNumber=1&pageSize=30` +
      `&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB`,
    );
    const rows = j?.result?.data ?? [];
    const items = [];
    for (const r of rows) {
      const per10 = typeof r.PRETAX_BONUS_RMB === 'number' ? r.PRETAX_BONUS_RMB : Number(r.PRETAX_BONUS_RMB);
      const ratio = typeof r.DIVIDENT_RATIO === 'number' ? r.DIVIDENT_RATIO : Number(r.DIVIDENT_RATIO);
      const progress = String(r.ASSIGN_PROGRESS ?? '');
      if (!Number.isFinite(per10) || per10 <= 0) continue;
      items.push({
        report_date: String(r.REPORT_DATE ?? '').slice(0, 10),
        per10,
        yield_pct: Number.isFinite(ratio) ? Number((ratio * 100).toFixed(2)) : null,
        implemented: progress.includes('实施') || progress.includes('完成'),
        progress,
      });
    }
    return { ok: true, items, years: new Set(items.map((x) => x.report_date.slice(0, 4))).size };
  } catch (e) {
    return { ok: false, items: [], error: String(e?.message ?? e) };
  }
}

/** 波动率与回撤 */
export function riskProfile(bars) {
  // 只取最近 250 个交易日：更早的历史（尤其前复权后可能出现负价）会污染波动率与回撤
  const window = (bars ?? []).slice(-250);
  const closes = window.map((b) => b.close).filter((v) => isNum(v) && v > 0);
  if (closes.length < 30) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const annualVol = Math.sqrt(variance) * Math.sqrt(252) * 100;

  // 最大回撤
  let peak = closes[0];
  let maxDD = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = ((c - peak) / peak) * 100;
    if (dd < maxDD) maxDD = dd;
  }

  // 长期趋势：250 日两端均线比较（用近 20 日均值 vs 120 日前 20 日均值）
  const tail = (arr, n) => arr.slice(-n).reduce((a, b) => a + b, 0) / n;
  const recent = closes.length >= 20 ? tail(closes, 20) : null;
  const past = closes.length >= 140 ? tail(closes.slice(0, closes.length - 120), 20) : null;
  const trendPct = recent !== null && past ? ((recent - past) / past) * 100 : null;

  return {
    annual_vol_pct: Number(annualVol.toFixed(1)),
    max_drawdown_pct: Number(maxDD.toFixed(1)),
    trend_120d_pct: trendPct === null ? null : Number(trendPct.toFixed(1)),
    samples: closes.length,
  };
}

/**
 * 综合评估
 * @param {object} facts gather 输出
 * @param {object} dividend fetchDividends 输出
 * @returns {{score:number|null, style:object, reasons:string[], caveats:string[]}}
 */
export function assessLongTerm(facts, dividend) {
  const bars = facts.kline_daily ?? [];
  const fin = facts.financials ?? {};
  const val = facts.valuation_pct ?? {};
  const q = facts.quote ?? {};
  const rp = riskProfile(bars);
  const reasons = [];
  const caveats = [];
  const d = dividend?.items ?? [];

  /* ── 分红 ── */
  const impl = d.filter((x) => x.implemented);
  const divYears = new Set(impl.map((x) => x.report_date.slice(0, 4))).size;
  const recentYields = impl.slice(0, 4).map((x) => x.yield_pct).filter(isNum);
  const avgYield = recentYields.length ? recentYields.reduce((a, b) => a + b, 0) / recentYields.length : null;
  // 用最近一次派息 + 当前股价估算当期股息率
  const lastPer10 = impl.length ? impl[0].per10 : null;
  const price = isNum(q.price) ? q.price : null;
  const liveYield = lastPer10 !== null && price ? ((lastPer10 / 10) / price) * 100 : null;

  let divScore = null;
  if (divYears > 0) {
    const yieldForScore = liveYield ?? avgYield;
    let s = Math.min(60, divYears * 6);            // 连续年数最多 60 分
    if (yieldForScore !== null) s += Math.min(40, yieldForScore * 8); // 股息率最高 40 分
    divScore = Math.min(100, s);
    if (yieldForScore !== null) {
      reasons.push(`近 ${divYears} 个年度有分红，按最近一次派息算股息率约 ${yieldForScore.toFixed(1)}%`);
    } else {
      reasons.push(`有 ${divYears} 个年度分红记录`);
    }
  } else {
    caveats.push('没有可用的现金分红记录——长线持有的现金流回报无法验证');
  }

  /* ── 稳定性（波动 + 回撤） ── */
  let stabScore = null;
  if (rp) {
    // 年化波动 15% 以下算很稳，45% 以上算很躁
    const volScore = Math.max(0, Math.min(100, 100 - (rp.annual_vol_pct - 15) * 3));
    // 回撤 -10% 内满分，-40% 归零
    const ddScore = Math.max(0, Math.min(100, 100 + (rp.max_drawdown_pct + 10) * 3));
    stabScore = Math.round(volScore * 0.55 + ddScore * 0.45);
    reasons.push(`年化波动 ${rp.annual_vol_pct}%、近 250 日最大回撤 ${rp.max_drawdown_pct}%`);
    if (rp.annual_vol_pct > 40) caveats.push(`波动率 ${rp.annual_vol_pct}% 偏大，长线持有过程会很颠簸`);
  } else {
    caveats.push('K 线不足，波动与回撤无法计算');
  }

  /* ── 盈利质量 ── */
  let qualityScore = null;
  if (isNum(fin.roe)) {
    const roeS = Math.max(0, Math.min(100, (fin.roe / 20) * 100));
    const gmS = isNum(fin.gross_margin) ? Math.max(0, Math.min(100, (fin.gross_margin / 45) * 100)) : 60;
    const debtS = isNum(fin.debt_ratio) ? Math.max(0, Math.min(100, 100 - fin.debt_ratio * 1.2)) : 60;
    qualityScore = Math.round(roeS * 0.5 + gmS * 0.25 + debtS * 0.25);
    reasons.push(`ROE(年化) ${fin.roe}%，毛利率 ${isNum(fin.gross_margin) ? fin.gross_margin.toFixed(1) + '%' : '—'}，负债率 ${isNum(fin.debt_ratio) ? fin.debt_ratio.toFixed(1) + '%' : '—'}`);
  } else {
    caveats.push('缺财务数据，盈利质量无法评估');
  }

  /* ── 估值 ── */
  let valScore = null;
  if (isNum(val.pe_ttm_pct)) {
    valScore = Math.max(0, Math.min(100, 100 - val.pe_ttm_pct));
    reasons.push(`PE 处于近三年 ${val.pe_ttm_pct}% 分位`);
    if (val.pe_ttm_pct > 80) caveats.push(`估值在近三年 ${val.pe_ttm_pct}% 分位，长线买入的安全边际不足`);
  }

  /* ── 加权 ── */
  const parts = [[divScore, 0.3], [stabScore, 0.3], [qualityScore, 0.25], [valScore, 0.15]]
    .filter(([s]) => s !== null);
  const wsum = parts.reduce((a, [, w]) => a + w, 0);
  const score = parts.length && wsum > 0
    ? Math.round(parts.reduce((a, [s, w]) => a + s * w, 0) / wsum)
    : null;

  /* ── 风格归类 ── */
  const style = classifyStyle({ score, divYears, liveYield: liveYield ?? avgYield, rp, fin, val, stageKey: null });

  if (style.key === 'compounder') {
    reasons.unshift('综合特征是「长牛/红利」型：靠分红和稳定现金流长期复利，不靠估值弹性');
  }

  return { score, style, reasons, caveats, metrics: { div_years: divYears, live_yield: liveYield, avg_yield: avgYield, risk: rp, parts: { div: divScore, stability: stabScore, quality: qualityScore, valuation: valScore } } };
}

/** 风格归类 */
export function classifyStyle({ score, divYears, liveYield, rp, fin, val }) {
  const yieldPct = isNum(liveYield) ? liveYield : 0;
  const vol = rp?.annual_vol_pct ?? null;
  const dd = rp?.max_drawdown_pct ?? 0;
  const growth = isNum(fin?.netprofit_yoy) ? fin.netprofit_yoy : null;

  if (divYears >= 5 && yieldPct >= 2.5 && vol !== null && vol < 30 && score >= 60) {
    return {
      key: 'compounder', name: '长牛红利型',
      mean: '靠稳定分红和低波动长期复利，适合拿得住的人',
      fit: '适合长线：在不追高的位置分批买，靠股息和业绩慢慢复利，不用天天看盘',
    };
  }
  if (divYears >= 3 && yieldPct >= 3.5) {
    return {
      key: 'high_yield', name: '高股息型',
      mean: '分红回报是主要收益来源，股价弹性次要',
      fit: '适合长线收息，但要确认分红可持续（看现金流和负债）',
    };
  }
  if (growth !== null && growth > 20 && vol !== null && vol > 40) {
    return {
      key: 'growth_volatile', name: '高成长高波动型',
      mean: '业绩弹性大但股价颠簸，长线拿需要很强的心理承受力',
      fit: '可以长线跟踪，但仓位要小，别用长线的名义扛短线波动',
    };
  }
  if (vol !== null && vol > 45) {
    return {
      key: 'trading', name: '交易型（波动大）',
      mean: '股价主要跟着情绪和资金走，不是靠基本面慢牛',
      fit: '这种票更适合按阶段和纪律做交易，不适合「买了就不管」',
    };
  }
  if (score !== null && score < 45) {
    return {
      key: 'not_longterm', name: '不适合长线',
      mean: '分红、稳定性、质量、估值四项至少两项明显不足',
      fit: '短线可以看，长线不建议重仓持有',
    };
  }
  return {
    key: 'neutral', name: '中性型',
    mean: '没有明显长牛特征，也没有明显硬伤',
    fit: '长线可小仓位观察，主要看后续业绩兑现',
  };
}

/** 长牛股参考样本（用于在界面上解释「什么叫长牛」） */
export const LONGTERM_REFERENCE = {
  name: '长江电力',
  code: '600900',
  traits: [
    '连续多年现金分红，股息率长期在 2.5%~4% 之间',
    '水电资产现金流稳定，业绩受经济周期影响小',
    '年化波动率长期低于 25%，回撤相对温和',
    '长期趋势向上，靠复利而不是靠估值弹性',
  ],
};
