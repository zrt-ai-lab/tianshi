/**
 * 投研结论生成器
 *
 * 产品定位纠偏：「别碰 / 能碰」这种二值标签没有信息量。
 * 这里产出的是**结构化的投研观点**——长周期、基本面、政策行业、市场环境，
 * 最后落到「这笔钱该怎么做」和「什么条件下改变判断」。
 *
 * 约束：
 *   1. 每个判断都挂数据依据，不写没有出处的话。
 *   2. 长周期统计必须过滤前复权产生的非正价（老股票会出现负价）。
 *   3. 结论可以是「不值得买」，但必须说明是「哪种钱不适合」还是「现在不适合」。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pctText = (v, digits = 1) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(digits)}%` : '—');
const yi = (v) => (isNum(v) ? `${(v / 1e8).toFixed(1)} 亿` : '—');

/** 长周期统计（过滤非正价） */
export function longTrend(bars) {
  const all = (bars ?? []).filter((b) => isNum(b.close) && b.close > 0 && isNum(b.high) && b.high > 0 && isNum(b.low) && b.low > 0);
  if (all.length < 60) return null;
  const n = all.length;
  const last = all[n - 1].close;
  const back = (k) => (n > k ? all[n - 1 - k].close : null);
  const retOf = (k) => {
    const v = back(k);
    return v && v > 0 ? ((last - v) / v) * 100 : null;
  };
  // 年化只用近 5 年窗口：更早的前复权价可能失真，用上市首日算会得出荒谬数字
  const win5 = all.slice(-1250);
  const years5 = win5.length / 250;
  const cagr = win5.length >= 250 && win5[0].close > 0 && years5 > 0.5
    ? (Math.pow(last / win5[0].close, 1 / years5) - 1) * 100
    : null;

  // 位置分位
  const window = (k) => {
    const w = all.slice(-k);
    if (!w.length) return null;
    const hi = Math.max(...w.map((b) => b.high));
    const lo = Math.min(...w.map((b) => b.low));
    return { hi, lo, pos: hi > lo ? ((last - lo) / (hi - lo)) * 100 : null };
  };

  // 长期趋势：MA250 与 250 日前 MA250 比较
  const ma = (k, offset = 0) => {
    const seg = all.slice(n - k - offset, n - offset);
    return seg.length === k ? seg.reduce((a, b) => a + b.close, 0) / k : null;
  };
  const ma250 = ma(250);
  const ma250Prev = ma(250, 250);
  const trendSlope = ma250 !== null && ma250Prev ? ((ma250 - ma250Prev) / ma250Prev) * 100 : null;

  // 回撤只算近 5 年：更早区间受复权调整影响，数值不可信
  const closes = win5.map((b) => b.close);
  let peak = closes[0];
  let maxDD = 0;
  for (const c of closes) { if (c > peak) peak = c; const dd = ((c - peak) / peak) * 100; if (dd < maxDD) maxDD = dd; }

  const w5 = window(1250);
  const w3 = window(750);
  const w1 = window(250);

  return {
    span_years: Number(((n - 1) / 250).toFixed(1)),
    bars: n,
    last,
    ret_1y: isNum(retOf(250)) ? Number(retOf(250).toFixed(1)) : null,
    ret_3y: isNum(retOf(750)) ? Number(retOf(750).toFixed(1)) : null,
    ret_5y: isNum(retOf(1250)) ? Number(retOf(1250).toFixed(1)) : null,
    cagr: isNum(cagr) ? Number(cagr.toFixed(1)) : null,
    ma250: ma250 === null ? null : Number(ma250.toFixed(2)),
    ma250_slope_pct: trendSlope === null ? null : Number(trendSlope.toFixed(1)),
    pos_1y: w1?.pos == null ? null : Number(w1.pos.toFixed(0)),
    pos_3y: w3?.pos == null ? null : Number(w3.pos.toFixed(0)),
    pos_5y: w5?.pos == null ? null : Number(w5.pos.toFixed(0)),
    max_drawdown: Number(maxDD.toFixed(1)),
    // 趋势判断要看多个周期，不能只看 MA250 斜率（长电这种慢牛斜率也很小）
    up_trend: (retOf(750) > 10 || retOf(1250) > 15 || (trendSlope !== null && trendSlope > 0.5)),
    mixed_trend: (retOf(250) !== null && retOf(250) < 0) && (retOf(750) > 10 || retOf(1250) > 15),
  };
}

/**
 * 生成投研观点
 * @param {object} ctx { facts, card, decision, stage, longterm, marketCycle, company, news, thead }
 */
export function buildOpinion(ctx) {
  const { facts = {}, card = {}, decision = {}, stage = null, longterm = null, marketCycle = null, company = null, news = null } = ctx;
  const bars = facts.kline_daily ?? [];
  const lt = longTrend(bars);
  const q = facts.quote ?? {};
  const fin = facts.financials ?? {};
  const val = facts.valuation_pct ?? {};
  const ff = facts.fund_flow ?? {};
  const sec = facts.sector ?? {};

  const paragraphs = [];
  const pushP = (label, text, tone) => paragraphs.push({ label, text, tone: tone ?? 'neutral' });

  /* ── ① 长周期怎么看 ── */
  if (lt) {
    const rets = [lt.ret_1y != null ? `近1年 ${pctText(lt.ret_1y)}` : null,
                  lt.ret_3y != null ? `近3年 ${pctText(lt.ret_3y)}` : null,
                  lt.ret_5y != null ? `近5年 ${pctText(lt.ret_5y)}` : null].filter(Boolean).join('、');
    const posTxt = lt.pos_5y == null ? '' : `当前价处于近 5 年区间的 ${lt.pos_5y}% 位置`;
    let dir;
    if (lt.mixed_trend) {
      dir = '中长期是向上的，但最近一年在回调';
    } else if (lt.up_trend) {
      dir = '长期趋势向上';
    } else {
      dir = '长期看没有走出持续上行';
    }
    // 长周期结论
    pushP('长周期', `${rets}${lt.cagr != null ? `（近5年年化约 ${pctText(lt.cagr)}）` : ''}。` +
      `${dir}；${posTxt}。近 5 年最大回撤 ${lt.max_drawdown}%。`,
      lt.mixed_trend ? 'caution' : lt.up_trend && (lt.pos_5y ?? 100) < 80 ? 'good' : (lt.pos_5y ?? 0) >= 90 ? 'caution' : 'neutral');
  }

  /* ── ② 基本面 ── */
  const finBits = [];
  if (isNum(fin.roe)) finBits.push(`ROE(年化) ${fin.roe}%`);
  if (isNum(fin.gross_margin)) finBits.push(`毛利率 ${fin.gross_margin.toFixed(1)}%`);
  if (isNum(fin.debt_ratio)) finBits.push(`负债率 ${fin.debt_ratio.toFixed(1)}%`);
  if (isNum(fin.revenue_yoy)) finBits.push(`营收同比 ${pctText(fin.revenue_yoy)}`);
  if (isNum(fin.netprofit_yoy)) finBits.push(`净利同比 ${pctText(fin.netprofit_yoy)}`);
  if (finBits.length) {
    const growthNote = isNum(fin.netprofit_yoy) && fin.netprofit_yoy < 0
      ? '，业绩在下滑，这是需要盯住的一点'
      : isNum(fin.netprofit_yoy) && fin.netprofit_yoy > 20
        ? '，业绩仍在扩张'
        : '';
    pushP('基本面', `${fin.report_name ? fin.report_name + '：' : ''}${finBits.join('、')}${growthNote}。`,
      isNum(fin.netprofit_yoy) && fin.netprofit_yoy < 0 ? 'caution' : 'neutral');
  }
  if (longterm?.metrics?.div_years) {
    const y = longterm.metrics.live_yield ?? longterm.metrics.avg_yield;
    pushP('分红', `近 ${longterm.metrics.div_years} 个年度有现金分红${isNum(y) ? `，按最近一次派息折算股息率约 ${y.toFixed(1)}%` : ''}。` +
      (isNum(y) && y >= 2.5 ? '分红是这类资产的主要回报来源之一。' : ''), 'neutral');
  }

  /* ── ③ 估值 ── */
  if (isNum(val.pe_ttm_pct)) {
    const cheap = val.pe_ttm_pct < 30;
    const rich = val.pe_ttm_pct > 75;
    pushP('估值', `PE ${isNum(val.current_pe) ? val.current_pe.toFixed(1) : '—'}，处于近三年 ${val.pe_ttm_pct}% 分位` +
      (cheap ? '——比过去三年大多数时间便宜' : rich ? '——比过去三年大多数时间贵' : '——处在历史中段') +
      (isNum(val.current_pb) ? `；PB ${val.current_pb.toFixed(2)}（${val.pb_pct == null ? '—' : val.pb_pct + '% 分位'}）` : '') + '。',
      cheap ? 'good' : rich ? 'caution' : 'neutral');
  }

  /* ── ④ 政策与行业 ── */
  const polNews = (news?.policy_news ?? []).slice(0, 2);
  const indBits = [];
  if (sec.matched) {
    indBits.push(`${sec.name} 当日 ${pctText(sec.pct_chg)}`);
    if (isNum(sec.rank_of_total) && isNum(sec.total)) {
      const pctRank = (sec.rank_of_total / sec.total) * 100;
      indBits.push(pctRank <= 30 ? '板块强度排在市场前列' : pctRank >= 70 ? '板块处于市场中后段' : '板块强度居中');
    }
  }
  if (polNews.length || indBits.length) {
    pushP('政策与行业',
      (indBits.length ? indBits.join('，') + '。' : '') +
      (polNews.length
        ? '近期相关政策线索：' + polNews.map((x) => x.title).join('；') + '。（仅关键词命中，不代表利好）'
        : '没有检索到与该公司/行业直接相关的政策新闻。'),
      'neutral');
  }

  /* ── ⑤ 市场环境 ── */
  if (marketCycle?.stage) {
    pushP('市场环境', `当前市场处于「${marketCycle.stage.name}」——${marketCycle.stage.mean}。` +
      (marketCycle.stage.key === 'retreat' || marketCycle.stage.key === 'ice'
        ? '这种环境下，即使是好公司也容易跟着跌，买点比选股更重要。'
        : marketCycle.stage.key === 'main' || marketCycle.stage.key === 'climax'
          ? '这种环境下强势股容易延续，但追高风险也在累积。'
          : '这种环境下更适合等回调、分批买。'),
      marketCycle.stage.key === 'retreat' ? 'caution' : 'neutral');
  }

  /* ── ⑥ 资金面 ── */
  const capBits = [];
  if (isNum(ff.main_net_5d)) capBits.push(`近5日主力 ${ff.main_net_5d > 0 ? '净流入' : '净流出'} ${yi(Math.abs(ff.main_net_5d))}`);
  if (isNum(ff.main_net_20d)) capBits.push(`近20日 ${ff.main_net_20d > 0 ? '净流入' : '净流出'} ${yi(Math.abs(ff.main_net_20d))}`);
  if (capBits.length) {
    pushP('资金', capBits.join('，') + '。' +
      (isNum(ff.main_net_20d) && ff.main_net_20d < 0 && isNum(ff.main_net_5d) && ff.main_net_5d > 0
        ? '短期在回流，但中期还在流出，属于修复而不是反转。'
        : ''), 'neutral');
  }

  /* ── ⑦ 这笔钱该怎么做（核心） ── */
  const styleKey = longterm?.style?.key ?? null;
  const isCompound = styleKey === 'compounder' || styleKey === 'high_yield';
  const rich = isNum(val.pe_ttm_pct) && val.pe_ttm_pct > 75;
  const nearHigh = isNum(lt?.pos_5y) && lt.pos_5y >= 85;
  const weakMarket = marketCycle?.stage?.key === 'retreat' || marketCycle?.stage?.key === 'ice';

  let stance;
  let actionTag;
  if (decision.verdict === 'avoid' && !isCompound) {
    actionTag = '观望为主';
    stance = '这类标的当前不适合建仓：' +
      (decision.why_not ? decision.why_not : '关键条件没有满足') +
      '。先放自选，等条件变化（风险降级、趋势修复、估值回落）再重新评估。';
  } else if (isCompound) {
    actionTag = '可配置，但别追高';
    stance = `它属于「${longterm.style.name}」，正确姿势是把它当**收息资产**来配，不是当短线票。` +
      (nearHigh ? '但当前处在近 5 年高位附近，' : '') +
      (rich ? '而且估值偏贵，' : '') +
      '建议用「跌了才买」的方式分批建仓，把成本摊在自己设定的区间里，而不是一次买在当前位置。';
  } else if (nearHigh || rich) {
    actionTag = '方向可以，位置不行';
    stance = '逻辑上没问题，但现在这个价格买入的赔率不划算——等回调到合理区间再动手，别在情绪最热的时候追。';
  } else {
    actionTag = '可以开始关注';
    stance = '条件基本具备，可以用小仓位试，边走边看。' + (weakMarket ? '但市场环境偏弱，仓位要更轻。' : '');
  }
  pushP('这笔钱该怎么做', stance, isCompound ? 'good' : decision.verdict === 'avoid' ? 'caution' : 'neutral');

  /* ── ⑧ 什么条件下改变判断 ── */
  const changeIf = [];
  if (stage?.stage) changeIf.push(`个股阶段从「${stage.stage.name}」切换（${stage.stage.watch ?? '量价结构改变'}）`);
  if (isNum(val.pe_ttm_pct)) changeIf.push(`PE 分位${rich ? '回落到 50% 以下' : '突破 80%'}（估值逻辑变化）`);
  if (isNum(fin.netprofit_yoy)) changeIf.push(`净利同比${fin.netprofit_yoy < 0 ? '转正' : '转负'}（业绩拐点）`);
  if (longterm?.metrics?.div_years) changeIf.push('分红方案下调或取消（收息逻辑破坏）');
  if (marketCycle?.stage) changeIf.push(`市场情绪周期切换（当前「${marketCycle.stage.name}」）`);

  /* ── 一句话标题 ── */
  const nameShort = facts.name ?? facts.symbol ?? '';
  let title;
  if (isCompound) {
    title = rich || nearHigh
      ? `${nameShort}：值得长期持有，但现在不是好买点`
      : `${nameShort}：适合当收息资产慢慢配`;
  } else if (decision.verdict === 'avoid') {
    title = `${nameShort}：现在不参与，等条件变化再说`;
  } else if (decision.verdict === 'buy') {
    title = `${nameShort}：条件具备，可以找回调建仓`;
  } else {
    title = `${nameShort}：方向能看，价格再等等`;
  }

  return {
    title,
    action_tag: actionTag,
    paragraphs,
    change_if: changeIf,
    long_trend: lt,
    caveats: [
      '本结论是数据驱动的条件判断，不是价格预测',
      '长周期统计已剔除前复权产生的异常价',
    ],
  };
}
