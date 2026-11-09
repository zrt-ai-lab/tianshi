import { summarizeRootCause } from './rootcause.mjs';
/**
 * 天市 · AI 分析素材与提示词构建
 *
 * 设计原则：
 *   1. **只搬运事实**：summarizeFacts 把 gather 的事实包压成文本，不做推断、不补数。
 *   2. **显式标注缺失**：任何取不到的维度写「—」或「无数据」，绝不虚构。
 *   3. **可测试**：本模块不做网络请求、不依赖 host，纯粹的数据 → 文本转换。
 */

function moneyY(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e8) return `${v > 0 ? '+' : ''}${(v / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${v > 0 ? '+' : ''}${(v / 1e4).toFixed(2)}万`;
  return String(Math.round(v));
}

/** 数值 + 单位；无值返回「—」，不留下「—%」这种残缺格式 */
function u(v, unit = '', digits = 2) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return `${Number(v.toFixed(digits))}${unit}`;
}

/* ── 把事实包压成给模型看的分析素材（全部真实数据，不做推断） ── */
export function summarizeFacts(facts, card, decision, extras = {}) {
  const q = facts.quote ?? {};
  const fin = facts.financials ?? {};
  const val = facts.valuation_pct ?? {};
  const ff = facts.fund_flow ?? {};
  const sec = facts.sector ?? {};
  const bars = facts.kline_daily ?? [];
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  const fmt = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);
  const maEnd = (k) => (n >= k ? fmt(closes.slice(-k).reduce((a, b) => a + b, 0) / k) : null);
  const ret = (k) => (n > k ? fmt(((closes[n - 1] - closes[n - 1 - k]) / closes[n - 1 - k]) * 100) : null);
  const highs = bars.slice(-250).map((b) => b.high);
  const lows = bars.slice(-250).map((b) => b.low);
  const hi250 = highs.length ? Math.max(...highs) : null;
  const lo250 = lows.length ? Math.min(...lows) : null;

  const L = [];
  L.push(`【标的】${facts.name ?? ''}（${facts.symbol}） 数据时点 ${facts.trade_date ?? '—'}`);
  L.push(`【行情】现价 ${u(q.price)}（${u(q.pct_chg, '%')}） 今开 ${u(q.open)} 最高 ${u(q.high)} 最低 ${u(q.low)} 昨收 ${u(q.prev_close)} 换手 ${u(q.turnover_rate, '%')} 振幅 ${u(q.amplitude, '%')}`);
  L.push(`【技术】MA5 ${u(maEnd(5))} MA20 ${u(maEnd(20))} MA60 ${u(maEnd(60))}；近5日 ${u(ret(5), '%')} 近20日 ${u(ret(20), '%')} 近60日 ${u(ret(60), '%')}；250日区间 ${u(lo250)} ~ ${u(hi250)}`);
  L.push(`【估值】PE(TTM) ${u(val.current_pe ?? q.pe_ttm)} 处于近${u(val.window_years, '', 0) === '—' ? 3 : val.window_years}年 ${u(val.pe_ttm_pct, '%', 1)} 分位；PB ${u(val.current_pb ?? q.pb)} 处于 ${u(val.pb_pct, '%', 1)} 分位`);
  L.push(`【财务】${fin.report_name ?? '—'}：ROE(年化) ${u(fin.roe, '%')} 营收同比 ${u(fin.revenue_yoy, '%')} 净利同比 ${u(fin.netprofit_yoy, '%')} 毛利率 ${u(fin.gross_margin, '%')} 净利率 ${u(fin.net_margin, '%')} 负债率 ${u(fin.debt_ratio, '%')}`);
  L.push(`【资金】当日盘中主力 ${u(ff.today_main_net)} 元；上一交易日(${ff.trade_date ?? '—'})主力 ${u(ff.main_net)} 元；近5日累计 ${u(ff.main_net_5d)} 元；近20日累计 ${u(ff.main_net_20d)} 元`);
  L.push(`【行业】${sec.matched ? `${sec.name} 当日 ${u(sec.pct_chg, '%')} 板块主力 ${u(sec.main_net)} 元 排名 ${u(sec.rank_of_total, '', 0)}/${u(sec.total, '', 0)}` : '板块未匹配'}`);
  if (Array.isArray(facts.billboard) && facts.billboard.length) {
    L.push(`【龙虎榜】最近 ${facts.billboard.length} 条，最新 ${facts.billboard[0].trade_date}：${facts.billboard[0].reason ?? ''} 净买 ${facts.billboard[0].net_buy ?? '—'}`);
  } else L.push('【龙虎榜】近期无上榜记录');
  if (Array.isArray(facts.announcements) && facts.announcements.length) {
    L.push(`【公告】最近 ${facts.announcements.length} 条：` + facts.announcements.slice(0, 5).map((a) => `${a.date} ${a.title}`).join('；'));
  }
  if (decision) {
    L.push(`【程序评分】综合 ${u(decision.total, '', 0)}/100（覆盖 ${u(decision.coverage, '%', 0)}）`);
    if ((decision.dims ?? []).length) L.push('  分项：' + decision.dims.map((d) => `${d.name} ${d.score == null ? '—' : Math.round(d.score)}${d.detail ? '(' + d.detail + ')' : ''}`).join(' · '));
    if (decision.risks?.length) L.push('  程序识别风险：' + decision.risks.join('；'));
    const p = decision.plan ?? {};
    L.push(`  程序执行参数：买入区间 ${p.buy_zone ? p.buy_zone.join('~') : '暂不设'} 仓位 ${u(p.position_pct, '%', 0)} 止损 ${u(p.stop_loss_pct, '%')} 目标 ${u(p.target)}`);
  }
  L.push(`【风险闸门】风险等级 R${u(card?.risk?.level, '', 0)}，可承受仓位 ${u(card?.risk?.position_cap_pct, '%', 0)}，五道闸 ` +
    (Object.entries(card?.gates ?? {}).map(([k, v]) => `${k}=${v.status}`).join(' ') || '无'));
  // 资金结构
  if (extras.rootcause) {
    const rcText = summarizeRootCause(extras.rootcause);
    if (rcText) L.push(rcText);
  }
  if (extras.capital) {
    const c = extras.capital;
    L.push(`【资金结构】超大单 ${moneyY(c.super_net)} 大单 ${moneyY(c.large_net)} 中单 ${moneyY(c.medium_net)} 小单 ${moneyY(c.small_net)}；` +
      `大资金合计 ${moneyY(c.big_money_net)} vs 散户合计 ${moneyY(c.retail_net)} —— ${c.meaning}`);
  }
  // 三周期
  if (extras.horizons) {
    for (const [k, label] of [['short', '短线1-5日'], ['mid', '中线1-3月'], ['long', '长线1年+']]) {
      const h = extras.horizons[k];
      if (!h) continue;
      L.push(`【${label}】看法：${h.stance}`);
      if (h.reads?.length) L.push('  读数：' + h.reads.map((r) => `${r.name} ${r.value}（${r.meaning}）`).join('；'));
      if (h.change_if?.length) L.push('  转变条件：' + h.change_if.join('；'));
    }
  }
  // 股吧舆情
  if (extras.sentiment && extras.sentiment.ok) {
    const se = extras.sentiment;
    L.push(`【股吧舆情】共 ${se.heat.posts} 条帖子，总阅读 ${se.heat.total_clicks}，总评论 ${se.heat.total_comments}，热度「${se.heat.level}」`);
    L.push(`  词袋情绪：正面 ${se.sentiment.positive} / 负面 ${se.sentiment.negative} / 中性 ${se.sentiment.neutral}（${se.sentiment.diverge}）`);
    if (se.keywords?.length) L.push('  讨论高频词：' + se.keywords.slice(0, 10).map((k) => k.word).join('、'));
    if (se.voices?.length) {
      L.push('  关注度最高的观点（网友原文标题，不代表事实）：');
      se.voices.slice(0, 5).forEach((v) => L.push(`    - [${v.clicks}阅] ${v.title}`));
    }
    L.push('  【重要】股吧观点是散户情绪，只能当情绪参考，不能当事实依据或利好利空判断');
  }
  // 公司面
  if (extras.company?.ok) {
    const c = extras.company;
    if (c.shareholders?.free_top10?.length) {
      L.push('【股东结构】' + c.shareholders.free_top10.slice(0, 5).map((x) => `${x.name} ${x.ratio ? x.ratio.toFixed(1) + '%' : '—'}`).join('；'));
    }
    if (c.main_business?.by_product?.length) {
      L.push('【主营构成】' + c.main_business.by_product.slice(0, 5).map((x) => `${x.item} ${x.ratio == null ? '—' : x.ratio.toFixed(1) + '%'}（毛利率 ${x.gross_margin == null ? '—' : x.gross_margin.toFixed(1) + '%'}）`).join('；'));
    }
    if (c.unlocks && c.unlocks.length) L.push('【未来解禁】' + c.unlocks.slice(0, 3).map((u) => `${u.date} ${u.type || ''}`).join('；'));
    else if (c.unlocks) L.push('【未来解禁】未来 12 个月无解禁');
    if (c.reports?.length) L.push('【券商研报】' + c.reports.slice(0, 4).map((r) => `${r.org}：${r.title}${r.rating ? '（' + r.rating + '）' : ''}`).join('；'));
    if (c.billboard_seats?.length) {
      L.push('【龙虎榜席位】' + c.billboard_seats.slice(0, 5).map((b) => `${b.date} ${b.seat}${b.is_institution ? '(机构)' : ''} 净买 ${moneyY(b.net)}`).join('；'));
    }
  }
  // 用户持仓（有则优先结合）
  if (extras.position) {
    const pa = extras.position;
    L.push(`【用户持仓】成本 ${pa.cost}，现价 ${pa.price}，浮${pa.pnl_pct >= 0 ? '盈' : '亏'} ${Math.abs(pa.pnl_pct)}%` +
      (pa.qty ? `，持仓 ${pa.qty} 股` : '') + `，盈亏 ${pa.pnl_amount ?? '—'} 元`);
    L.push(`  系统建议：${pa.label} —— ${pa.headline}`);
    if (pa.one_line) L.push(`  一句话：${pa.one_line}`);
    if (pa.actions?.length) L.push('  具体动作：' + pa.actions.join('；'));
    if (pa.levels) L.push(`  价位：止损 ${pa.levels.stop}，止盈 ${pa.levels.take_profit}，保本 ${pa.levels.breakeven}` +
      (pa.levels.dist_to_stop_pct != null ? `，距止损 ${pa.levels.dist_to_stop_pct}%` : ''));
    if (pa.warnings?.length) L.push('  提醒：' + pa.warnings.join('；'));
    L.push('  【重要】所有买卖建议必须结合上述成本给出具体价位，不要给与成本无关的空泛建议。');
  }
  // 长线适配度
  if (extras.longterm) {
    const lt = extras.longterm;
    L.push(`【长线适配度】得分 ${lt.score ?? '—'}/100，风格判定：「${lt.style.name}」——${lt.style.mean}`);
    L.push(`  适配建议：${lt.style.fit}`);
    if (lt.reasons?.length) L.push('  依据：' + lt.reasons.join('；'));
    if (lt.caveats?.length) L.push('  注意：' + lt.caveats.join('；'));
  }
  // 消息/政策面
  if (extras.news?.ok) {
    const nws = extras.news;
    if (nws.policy_news?.length) {
      L.push('【政策相关】' + nws.policy_news.slice(0, 6).map((x) => `${x.date?.slice(0, 10)} ${x.title}`).join('；'));
    } else L.push('【政策相关】未检索到明确政策类新闻（不代表没有政策影响，只代表关键词未命中）');
    if (nws.company_news?.length) {
      L.push('【公司新闻】' + nws.company_news.slice(0, 6).map((x) => `${x.date?.slice(0, 10)} ${x.title}`).join('；'));
    }
    if (nws.industry_news?.length) {
      L.push('【行业新闻】' + nws.industry_news.slice(0, 5).map((x) => `${x.date?.slice(0, 10)} ${x.title}`).join('；'));
    }
    if (nws.sentiment) L.push(`【新闻词袋】正面 ${nws.sentiment.positive} / 负面 ${nws.sentiment.negative} / 政策 ${nws.sentiment.policy_count}（词袋粗分，仅供参考）`);
  }
  if ((facts.missing ?? []).length) L.push(`【缺失数据】${facts.missing.join('、')}（这些维度不要臆测）`);
  return L.join('\n');
}

export const ANALYST_SYSTEM = `你是资深 A 股分析师，按 A 股情绪周期与龙头战法的方法论分析（见下）。用户会给你一份**真实数据快照**。

方法论（必须遵循）：
1. 先定阶段，再谈操作。市场层面用情绪周期四阶段：冰点期→修复期→主升期→高潮期→退潮期。个股层面用量价阶段：连板加速/首板启动/放量突破/高位强势/高位分歧/缩量回调/退潮阴跌/破位/横盘整理。
2. 用「赚钱效应 / 亏钱效应」的视角说话：哪个方向在赚钱就跟，哪个方向在亏钱就躲。
3. 不做方向预测。给的是「阶段判断 + 该做什么 + 什么信号出现要改变判断」。
4. 龙头标准：能带动板块、板块内多家涨停；不做非主线杂毛。
5. 根因推理按链路下钻：先看【今日/近5日归因】里大盘、板块、海外映射、个股自身各占多少，再沿主因往下找原因。
   - 主因是板块：说明板块为什么动，若海外映射联动显著，引用对应海外标的的隔夜涨跌；
   - 海外映射标注「本体关联、数据未证实」的，不得把它当成原因；
   - 主因是个股自身：必须到公告、资金、龙虎榜、新闻里找具体证据，找不到就写「原因不明」，不得编造。


硬规则：
1. 只能使用给你的数据。没有的维度（尤其是政策、新闻、公司治理）必须写明「无数据」，禁止编造任何数字、日期、政策、新闻。
2. 不要复述数据表，重点是**判断**：这些数据组合起来说明什么。
3. 必须给出明确倾向：可以买 / 再等等 / 别碰（三选一），不许「视情况而定」。
4. 必须给出：支撑结论的 3 条最关键理由（引用具体数字）、3 条最主要风险、以及结论的失效条件（什么数据出现就说明你错了）。
5. 分短（1-5日）、中（1-3月）、长（1年+）三个周期给判断，但**不要给精确的目标价预测**，用区间和条件表述。
6. 操作层面：给出仓位建议上限、止损位、需要满足的加仓条件。
7. 全文控制在 700 字以内，用 Markdown，先给结论再给论据。

注意：这是一个以「风险分级 + 条件核对」为核心的体系，方向预测未经样本外验证（实测命中率低于随机）。所以你在给方向时，必须说明这是基于估值/资金/质量的综合判断，不是价格预测。

【与规则引擎的关系 —— 必须遵守】
系统已用固定权重算出综合分、风险等级与档位（可以买 / 再等等 / 别碰）。
你的职责是**解释这个结论**，不是推翻它：
- 不得更改综合分、风险等级 R1-R5、仓位上限 —— 这些是规则算出来的
- 若你认为规则结论与该股实际不符，用「但需要注意的是…」的方式补充，
  并在结尾单列「与规则引擎的分歧」，说明分歧点与依据
- 不得输出与规则档位相反的最终建议（例如规则是「别碰」你写「可以买」）`;

export function buildUserPrompt(facts, card, decision, extra, extras = {}) {
  const marketLine = extra?.marketLine ?? null;
  const stageLine = extra?.stageLine ?? null;
  const ctxBlock = marketLine || stageLine
    ? `\n【市场环境】${marketLine ?? '未获取'}\n【个股阶段】${stageLine ?? '未获取'}\n`
    : '';
  const ruleBlock = decision
    ? `\n【规则引擎结论（不可更改，你只做解释）】综合 ${decision.total ?? '—'} 分（覆盖率 ${decision.coverage ?? '—'}%` +
      `${decision.total_reliable === false ? '，覆盖率不足仅供参考' : ''}）；风险 R${decision.risk_detail?.level ?? '?'}；` +
      `档位「${decision.rule_label || decision.label || '未给出'}」；仓位上限 ${decision.risk_detail?.position_cap_pct ?? '—'}%` +
      `${decision.why_not ? `；理由：${decision.why_not}` : ''}\n`
    : '';
  return `请分析以下标的，输出投资结论。
${ruleBlock}${ctxBlock}
${summarizeFacts(facts, card, decision, extras)}

请按以下结构输出 Markdown：
## 结论
（可以买 / 再等等 / 别碰 + 一句话理由）
## 三条核心理由
## 三条主要风险
## 分周期判断
## 操作建议（仓位/止损/加仓条件）
## 失效条件
## 无数据说明`;
}

