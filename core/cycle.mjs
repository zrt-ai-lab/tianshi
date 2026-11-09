/**
 * 阶段判断引擎
 *
 * 依据 knowledge/a-share-playbook.md：
 *   1. 市场层面：情绪周期四阶段（冰点 / 修复 / 主升 / 高潮 / 退潮）
 *   2. 个股层面：量价阶段（连板加速 / 首板启动 / 放量突破 / 高位分歧 / 缩量回调 / 退潮阴跌 / 破位 / 横盘）
 *
 * 纪律：阶段判断是**描述现在**，不是预测未来。每个判断都必须给出触发证据与本阶段该做什么。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (a, b) => (isNum(a) && isNum(b) && b ? ((a - b) / b) * 100 : null);

/* ══════════════ 市场：情绪周期 ══════════════ */

export const CYCLE_STAGES = {
  ice: {
    key: 'ice', name: '冰点期',
    mean: '赚钱效应枯竭，资金在低位试错找方向',
    do: '轻仓或空仓；只做低位首板试错，不接高位断板',
    watch: '哪个方向开始出现持续性（连续两日以上涨停扩散）',
  },
  repair: {
    key: 'repair', name: '修复期',
    mean: '亏钱效应在收敛，开始有资金愿意接力',
    do: '小仓位试主线首板与二板；确认龙头是谁再加大',
    watch: '晋级率能否抬升、炸板率能否降下来',
  },
  main: {
    key: 'main', name: '主升期',
    mean: '主线清晰，龙头带队，梯队完整',
    do: '这是唯一可以重仓的阶段：做主线龙头与梯队卡位',
    watch: '龙头是否断板、后排是否开始掉队（分歧前兆）',
  },
  climax: {
    key: 'climax', name: '高潮期',
    mean: '题材集体涨停，跟风资金涌入，赚钱效应最强也最脆弱',
    do: '持有但不追高；高潮次日往往就是分歧，准备减仓',
    watch: '炸板率是否抬升、后排是否大面积补涨（毕业照特征）',
  },
  retreat: {
    key: 'retreat', name: '退潮期',
    mean: '龙头杀跌，泥沙俱下，动手就吃面',
    do: '空仓。不抄底、不抢反弹、不接飞刀',
    watch: '跌停家数何时收敛、炸板率何时回落 —— 那是下一个冰点',
  },
};

/**
 * @param {object} m fetchMarket 的返回
 * @returns {{stage:object, confidence:string, evidence:string[], contradictions:string[], missing:string[]}}
 */
export function marketCycle(m) {
  const limit = m.limit ?? {};
  const breadth = m.breadth ?? {};
  const amount = m.amount ?? {};
  const evidence = [];
  const contradictions = [];
  const missing = [];

  const zt = limit.up;
  const dt = limit.down;
  const zb = limit.broken_rate;
  const maxBoard = limit.max_board;
  const lianban = limit.lianban_count;
  const upRatio = breadth.up_ratio;
  const amtChg = amount.sh_change_pct;

  if (!isNum(zt)) missing.push('涨停家数');
  if (!isNum(zb)) missing.push('炸板率');
  if (!isNum(maxBoard)) missing.push('最高连板（涨停池）');
  if (!isNum(upRatio)) missing.push('上涨家数占比');

  // 打分：各阶段特征累积
  const score = { ice: 0, repair: 0, main: 0, climax: 0, retreat: 0 };
  const add = (k, n, why) => { score[k] += n; if (why) evidence.push(why); };

  // 退潮特征：炸板率高、跌停多、涨停骤减
  if (isNum(zb) && zb >= 50) add('retreat', 3, `炸板率 ${zb}%（≥50% 说明追高被套严重）`);
  else if (isNum(zb) && zb >= 40) add('retreat', 1, `炸板率 ${zb}%（承接力偏弱）`);
  if (isNum(dt) && dt >= 10) add('retreat', 3, `跌停 ${dt} 家（≥10 家是亏钱效应扩散）`);
  else if (isNum(dt) && dt >= 5) add('retreat', 1, `跌停 ${dt} 家`);

  // 高潮特征：涨停极多 + 连板高度高 + 炸板率低
  if (isNum(zt) && zt >= 80) add('climax', 3, `涨停 ${zt} 家（≥80 家是普涨级赚钱效应）`);
  else if (isNum(zt) && zt >= 60) add('climax', 1, `涨停 ${zt} 家`);
  if (isNum(maxBoard) && maxBoard >= 6) add('climax', 2, `最高连板 ${maxBoard} 板（空间板打开）`);
  if (isNum(zb) && zb <= 25 && isNum(zt) && zt >= 60) add('climax', 1, `炸板率仅 ${zb}%，承接强`);

  // 主升特征：主线清晰，涨停较多，梯队有厚度
  if (isNum(zt) && zt >= 55 && zt < 80) add('main', 2, `涨停 ${zt} 家，赚钱效应扩散`);
  if (isNum(maxBoard) && maxBoard >= 4 && maxBoard < 6) add('main', 2, `最高连板 ${maxBoard} 板，空间打开但未过热`);
  if (isNum(lianban) && lianban >= 5) add('main', 2, `连板家数 ${lianban}，梯队有厚度`);
  if (isNum(upRatio) && upRatio >= 55) add('main', 1, `上涨家数占比 ${upRatio}%，宽度健康`);

  // 修复特征：中等涨停、宽度改善、量能回升
  if (isNum(zt) && zt >= 40 && zt < 55) add('repair', 2, `涨停 ${zt} 家，中等强度`);
  if (isNum(upRatio) && upRatio >= 45 && upRatio < 55) add('repair', 1, `上涨家数占比 ${upRatio}%，多空胶着`);
  if (isNum(amtChg) && amtChg > 5) add('repair', 1, `成交额环比 +${amtChg.toFixed(1)}%，增量资金进场`);

  // 冰点特征：涨停少、宽度差
  if (isNum(zt) && zt < 40) add('ice', 3, `涨停仅 ${zt} 家（<40 家是情绪冰点区）`);
  if (isNum(upRatio) && upRatio < 35) add('ice', 2, `上涨家数占比仅 ${upRatio}%`);
  if (isNum(maxBoard) && maxBoard <= 2) add('ice', 2, `最高连板仅 ${maxBoard} 板，没有高度`);

  // 反向矛盾提示
  if (isNum(zt) && zt >= 60 && isNum(upRatio) && upRatio < 45) {
    contradictions.push(`涨停 ${zt} 家但上涨家数仅 ${upRatio}% —— 结构性行情，赚钱集中不代表普涨`);
  }
  if (isNum(maxBoard) && maxBoard >= 5 && isNum(zb) && zb >= 45) {
    contradictions.push(`最高 ${maxBoard} 板但炸板率 ${zb}% —— 高度还在，但接力已经开始亏钱`);
  }

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const second = ranked[1];
  let stage = CYCLE_STAGES[top[0]] ?? CYCLE_STAGES.repair;
  let confidence = 'low';
  if (top[1] >= 4 && top[1] - second[1] >= 2) confidence = 'high';
  else if (top[1] >= 3 && top[1] > second[1]) confidence = 'medium';
  else {
    // 分歧不清时归入修复期（最保守的中间态）
    stage = CYCLE_STAGES.repair;
    confidence = 'low';
  }

  return {
    stage,
    confidence,
    score,
    evidence: evidence.slice(0, 6),
    contradictions,
    missing,
    raw: { zt, dt, zb, maxBoard, lianban, upRatio, amtChg },
  };
}

/* ══════════════ 个股：量价阶段 ══════════════ */

const STAGE_OF_STOCK = {
  limit_chain: { key: 'limit_chain', name: '连板加速', do: '情绪票，只有主线龙头可参与；断板即走，不接' },
  first_board: { key: 'first_board', name: '首板启动', do: '看次日能否连板、板块是否跟随；不能连板就要走' },
  breakout: { key: 'breakout', name: '放量突破', do: '趋势启动候选，等回踩 MA20 不破再考虑' },
  strong_high: { key: 'strong_high', name: '高位强势', do: '强势但风险累积，只做回踩不追高' },
  divergence: { key: 'divergence', name: '高位分歧', do: '放量回落＝出货特征，回避' },
  pullback: { key: 'pullback', name: '缩量回调', do: '健康回调，等缩量企稳再看' },
  ebb: { key: 'ebb', name: '退潮阴跌', do: '没人接力，不接飞刀' },
  broken: { key: 'broken', name: '破位', do: '趋势转坏，回避' },
  range: { key: 'range', name: '横盘整理', do: '等方向选择，不预判' },
};

const maEnd = (arr, n) => (arr.length < n ? null : arr.slice(-n).reduce((a, b) => a + b, 0) / n);

/**
 * @param {object} facts gather 输出
 * @returns {{stage:object, features:object, evidence:string[]}}
 */
export function stockStage(facts) {
  const bars = Array.isArray(facts.kline_daily) ? facts.kline_daily : [];
  const evidence = [];
  if (bars.length < 60) {
    return { stage: null, features: {}, evidence: ['K 线不足 60 根，无法判断阶段'] };
  }
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume ?? 0);
  const n = closes.length;
  const last = closes[n - 1];

  const code = String(facts.symbol ?? '');
  const name = String(facts.name ?? '');
  // 各板块涨跌停幅度不同，判错会导致连板数与首板识别全错：
  //   北交所（83/87/88/92/43/82 开头）30%
  //   ST / *ST                                    5%
  //   创业板（30）/ 科创板（68）                     20%
  //   沪深主板                                     10%
  // 留 0.6pp 余量，避免前复权误差导致漏判
  const isBse = /^(83|87|88|92|43|82)/.test(code);
  const isST = /ST/i.test(name);
  const is20 = /^(30|68)/.test(code);
  const limitPct = isBse ? 29.4 : isST ? 4.6 : is20 ? 19.4 : 9.4;
  const limitBase = isBse ? 30 : isST ? 5 : is20 ? 20 : 10;
  const boardKind = isBse ? '北交所' : isST ? 'ST' : is20 ? '双创' : '主板';

  // 连续涨停数
  let boards = 0;
  for (let i = n - 1; i > 0; i--) {
    const chg = pct(closes[i], closes[i - 1]);
    if (chg !== null && chg >= limitPct) boards += 1;
    else break;
  }
  const todayChg = pct(closes[n - 1], closes[n - 2]);

  // 位置：250 日区间
  const win = bars.slice(-250);
  const hi250 = Math.max(...win.map((b) => b.high));
  const lo250 = Math.min(...win.map((b) => b.low));
  const pos = hi250 > lo250 ? ((last - lo250) / (hi250 - lo250)) * 100 : null;
  const fromHigh = hi250 ? ((last - hi250) / hi250) * 100 : null;

  // 量比
  const v5 = maEnd(vols, 5);
  const v20 = maEnd(vols, 20);
  const volRatio = v5 && v20 ? v5 / v20 : null;

  // 均线
  const ma5 = maEnd(closes, 5);
  const ma20 = maEnd(closes, 20);
  const ma60 = maEnd(closes, 60);
  const ret5 = pct(last, closes[n - 6]);
  const ret20 = pct(last, closes[n - 21]);

  const features = {
    boards, today_chg: todayChg, limit_pct: limitBase, board: boardKind, pos250: pos === null ? null : Number(pos.toFixed(1)),
    from_high: fromHigh === null ? null : Number(fromHigh.toFixed(1)),
    vol_ratio: volRatio === null ? null : Number(volRatio.toFixed(2)),
    ma5, ma20, ma60, ret5, ret20,
  };

  // 阶段判定（优先级从高到低）
  let stage;
  if (boards >= 2) {
    stage = STAGE_OF_STOCK.limit_chain;
    evidence.push(`连续 ${boards} 个涨停（今日 ${todayChg?.toFixed(2)}%），处于情绪加速段`);
  } else if (boards === 1 && pos !== null && pos < 75) {
    stage = STAGE_OF_STOCK.first_board;
    evidence.push(`今日涨停（${boardKind} 涨停幅度 ${limitBase}%）且 250 日位置 ${pos.toFixed(0)}%，属于中低位首板`);
  } else if (ma60 !== null && last < ma60 * 0.97) {
    stage = STAGE_OF_STOCK.broken;
    evidence.push(`收盘 ${last} 跌破 MA60 ${ma60.toFixed(2)}（约 -${((1 - last / ma60) * 100).toFixed(1)}%）`);
  } else if (pos !== null && pos > 80 && ret5 !== null && ret5 < -4 && volRatio !== null && volRatio > 1.2) {
    stage = STAGE_OF_STOCK.divergence;
    evidence.push(`250 日位置 ${pos.toFixed(0)}% 且近 5 日 ${ret5.toFixed(1)}%，量比 ${volRatio.toFixed(2)} —— 高位放量回落`);
  } else if (fromHigh !== null && fromHigh < -15 && volRatio !== null && volRatio < 0.85) {
    stage = STAGE_OF_STOCK.ebb;
    evidence.push(`距 250 日高点 ${fromHigh.toFixed(1)}%，量比仅 ${volRatio.toFixed(2)} —— 缩量阴跌`);
  } else if (pos !== null && pos > 85 && fromHigh !== null && fromHigh > -8) {
    stage = STAGE_OF_STOCK.strong_high;
    evidence.push(`250 日位置 ${pos.toFixed(0)}%，距高点仅 ${fromHigh.toFixed(1)}%`);
  } else if (ma20 !== null && last > ma20 && volRatio !== null && volRatio > 1.5 && ret5 !== null && ret5 > 4) {
    stage = STAGE_OF_STOCK.breakout;
    evidence.push(`站上 MA20，近 5 日 +${ret5.toFixed(1)}%，量比 ${volRatio.toFixed(2)} —— 放量突破`);
  } else if (ret5 !== null && ret5 < 0 && volRatio !== null && volRatio < 0.8) {
    stage = STAGE_OF_STOCK.pullback;
    evidence.push(`近 5 日 ${ret5.toFixed(1)}% 但量比仅 ${volRatio.toFixed(2)} —— 缩量回调`);
  } else {
    stage = STAGE_OF_STOCK.range;
    evidence.push(`近 5 日 ${ret5 === null ? '—' : ret5.toFixed(1)}%、量比 ${volRatio === null ? '—' : volRatio.toFixed(2)}，无明确方向`);
  }

  return { stage, features, evidence };
}
