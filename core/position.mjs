/**
 * 持仓顾问：把「你的成本」接进决策
 *
 * 核心逻辑：同一只票，成本不同，该做的事完全不同。
 *   浮盈 20% 破位 → 保利润，减仓
 *   浮亏 10% 破位 → 止损，别扛
 *   成本在低位、趋势健康 → 拿住，跌破成本保护
 *
 * 所有价位都基于真实数据（决策止损、目标、MA、ATR）与你的成本计算。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {object} ctx
 *  price 现价, cost 成本价, qty 股数,
 *  decision 五维决策, stage 量价阶段, risk 风险对象, pathways 三条路径
 * @returns {object|null}
 */
export function advisePosition(ctx) {
  const { price, cost, qty, decision, stage, risk, pathways } = ctx ?? {};
  if (!isNum(price) || !isNum(cost) || cost <= 0) return null;

  const pnlPct = ((price - cost) / cost) * 100;
  const pnlAmt = (price - cost) * (isNum(qty) ? qty : 0);
  const stageKey = stage?.stage?.key ?? null;
  const level = isNum(risk?.level) ? risk.level : null;
  const broken = stageKey && ['broken', 'ebb', 'divergence'].includes(stageKey);

  // 决策给出的止损/目标（相对现价）
  const plan = decision?.plan ?? {};
  const decStop = isNum(plan.stop_loss_pct) ? price * (1 + plan.stop_loss_pct / 100) : null;
  const decTarget = isNum(plan.target) ? plan.target : null;
  const ma20 = pathways?.ma20 ?? ctx?.ma20 ?? null;

  /* ── 具体价位（止损必须在现价下方，止盈必须在现价上方） ── */
  let stopPrice = decStop ?? (broken ? price * 0.97 : Math.min(cost * 0.92, price * 0.96));
  stopPrice = Math.min(stopPrice, price * 0.995);
  let takeProfit = decTarget ?? price * 1.08;
  takeProfit = Math.max(takeProfit, price * 1.005);
  const addZone = ma20 ? [Number((ma20 * 0.99).toFixed(2)), Number((ma20 * 1.01).toFixed(2))] : null;
  const breakeven = cost;

  const actions = [];
  const warnings = [];

  /* ── 判定动作 ── */
  let action = 'hold';
  let label = '继续持有';
  let headline = '';

  if (broken && pnlPct <= -5) {
    action = 'cut';
    label = '止损离场';
    headline = `你已经浮亏 ${pnlPct.toFixed(1)}%，而股价${stage.stage.name}——先出来，别越扛越深`;
    actions.push(`以 ${(decStop ?? price * 0.97).toFixed(2)} 为最后的止损线（跌破当天走，不猜反弹）`);
    actions.push('卖出后先把这只票移出自选，等趋势修复再回来看');
  } else if (broken && pnlPct > 10) {
    action = 'reduce';
    label = '减仓保利润';
    headline = `浮盈 ${pnlPct.toFixed(1)}% 但趋势已经走坏——赚到的先落袋，别把利润还回去`;
    actions.push(`先卖出至少一半（现价 ${price.toFixed(2)} 附近），剩余仓位止损放在成本价 ${cost.toFixed(2)}（保本）`);
    actions.push('若跌破 MA20，剩余也走');
  } else if (broken) {
    action = 'reduce';
    label = '减仓观望';
    headline = `浮盈浮亏 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%，但${stage.stage.name}——先降仓位，等趋势修复`;
    actions.push(`减到原仓位的一半以下，剩余止损设在 ${(decStop ?? price * 0.97).toFixed(2)}`);
  } else if (level !== null && level >= 4 && pnlPct > 15) {
    action = 'take_profit';
    label = '分批止盈';
    headline = `浮盈 ${pnlPct.toFixed(1)}%，但风险等级 R${level}——利润够了就先收一部分`;
    actions.push(`在 ${price.toFixed(2)} 先卖 1/3，剩余设移动止盈：跌破 ${(price * 0.93).toFixed(2)} 再卖 1/3`);
  } else if (pnlPct <= -10) {
    action = 'cut';
    label = '该做决定';
    headline = `浮亏 ${pnlPct.toFixed(1)}% 已超过 10%——要么按纪律止损，要么承认这是长线仓位，别两边都占`;
    actions.push(`如果这是短线仓位：破 ${stopPrice.toFixed(2)} 就走`);
    actions.push('如果这是长线仓位：看逻辑有没有变（业绩、分红、行业），逻辑没变才谈拿住');
  } else if (pnlPct >= 20) {
    action = 'hold';
    label = '持有 + 移动止盈';
    headline = `浮盈 ${pnlPct.toFixed(1)}% 且趋势健康——让它跑，但把止盈线往上抬`;
    actions.push(`止盈线设在 ${(price * 0.9).toFixed(2)}（回撤 10% 就卖），跌破再走，不预测顶部`);
  } else if (pnlPct < 0) {
    action = 'hold';
    label = '持有观察';
    headline = `浮亏 ${Math.abs(pnlPct).toFixed(1)}%，趋势尚未走坏——给它时间，但设好底线`;
    actions.push(`底线设在 ${(decStop ?? cost * 0.92).toFixed(2)}，跌破无条件走`);
    actions.push(`回到成本 ${cost.toFixed(2)} 上方站稳，再考虑要不要加`);
  } else {
    action = 'hold';
    label = '持有';
    headline = `浮盈 ${pnlPct.toFixed(1)}%，趋势和风险都还正常——继续持有，按计划管理`;
    actions.push(`止盈参考 ${(decTarget ?? price * 1.1).toFixed(2)}，止损参考 ${(decStop ?? cost * 0.92).toFixed(2)}`);
  }

  const distToStop = stopPrice ? ((stopPrice - price) / price) * 100 : null;
  const distToTarget = takeProfit ? ((takeProfit - price) / price) * 100 : null;
  const rrFromHere = distToStop && distToTarget && distToStop < 0
    ? Number((distToTarget / Math.abs(distToStop)).toFixed(2))
    : null;

  if (pnlPct > 0 && stopPrice < cost) {
    warnings.push(`止损位 ${stopPrice.toFixed(2)} 低于你的成本 ${cost.toFixed(2)}：按此止损会把浮盈变成${((stopPrice - cost) / cost * 100).toFixed(1)}% 的实质亏损`);
  }
  if (level !== null && level >= 4) warnings.push(`当前风险等级 R${level}，不适合加仓`);
  if (action === 'hold' && pnlPct < 0) warnings.push('不要在亏损时为了“摊低成本”而加仓——先确认逻辑没坏');

  /* ── 一句话建议 ── */
  let oneLine;
  if (action === 'cut') oneLine = `成本 ${cost.toFixed(2)}，现价 ${price.toFixed(2)}，浮亏 ${pnlPct.toFixed(1)}%：该走就走，别扛。`;
  else if (action === 'reduce' || action === 'take_profit') oneLine = `成本 ${cost.toFixed(2)}，现价 ${price.toFixed(2)}，浮盈 ${pnlPct.toFixed(1)}%：先落一部分，剩下的抬止盈。`;
  else if (pnlPct >= 0) oneLine = `成本 ${cost.toFixed(2)}，现价 ${price.toFixed(2)}，浮盈 ${pnlPct.toFixed(1)}%：拿着，跌破 ${stopPrice.toFixed(2)} 再动。`;
  else oneLine = `成本 ${cost.toFixed(2)}，现价 ${price.toFixed(2)}，浮亏 ${Math.abs(pnlPct).toFixed(1)}%：拿到 ${cost.toFixed(2)} 上方站稳再说，跌破 ${stopPrice.toFixed(2)} 走。`;

  return {
    cost,
    price,
    qty: isNum(qty) ? qty : null,
    pnl_pct: Number(pnlPct.toFixed(2)),
    pnl_amount: isNum(qty) ? Number(pnlAmt.toFixed(0)) : null,
    action,
    label,
    headline,
    one_line: oneLine,
    actions,
    warnings,
    levels: {
      stop: Number(stopPrice.toFixed(2)),
      take_profit: Number(takeProfit.toFixed(2)),
      breakeven: Number(breakeven.toFixed(2)),
      add_zone: addZone,
      dist_to_stop_pct: distToStop === null ? null : Number(distToStop.toFixed(2)),
      dist_to_target_pct: distToTarget === null ? null : Number(distToTarget.toFixed(2)),
      rr_from_here: rrFromHere,
    },
  };
}
