/**
 * 数据来源登记表
 *
 * 目的：把「我们到底从哪拿数据、有没有交叉验证、边界在哪」写死成可查询的清单，
 * 而不是靠口头描述。界面上直接展示这一份。
 *
 * 三个诚实结论先说清楚：
 *   1. 所有数据都是腾讯财经 / 东方财富的公开接口，不是交易所直连，也不是官方授权数据。
 *   2. 只有「行情（价格/涨跌幅/最高/最低）」做了双源交叉验证，其他维度是单源。
 *   3. 同花顺、雪球、微博/大 V 观点、股吧帖子 —— 全部没有接入。
 */

export const SOURCE_REGISTRY = [
  {
    group: '行情',
    items: [
      {
        dim: '实时价格 / 涨跌幅 / 最高最低',
        sources: ['腾讯财经 qt.gtimg.cn', '东方财富 push2'],
        cross: true,
        cross_note: '双源逐字段比对，价格容差 0.011 元、涨跌幅容差 0.05%，超差记为冲突并降级风控',
        official: false,
        limit: '均为第三方行情聚合接口，非交易所直连；盘中可能有秒级延迟',
      },
      {
        dim: '日 K 线（前复权）',
        sources: ['东方财富 push2his kline'],
        cross: false,
        official: false,
        limit: '单源；前复权在早期历史可能产生异常值，长周期统计已做非正价过滤',
      },
      {
        dim: '分时（1 分钟）',
        sources: ['东方财富 push2his trends2'],
        cross: false,
        official: false,
        limit: '单源；盘中为快照，收盘后为完整',
      },
      {
        dim: '逐笔成交（单数分析）',
        sources: ['腾讯财经 stock.gtimg.cn detail'],
        cross: false,
        official: false,
        limit: '只取最近约 180 笔，不是全量逐笔；单笔金额按手数×价格估算',
      },
      {
        dim: '五档盘口',
        sources: ['腾讯财经 qt.gtimg.cn'],
        cross: false,
        official: false,
        limit: '快照瞬时值，非 Level-2 逐笔委托',
      },
    ],
  },
  {
    group: '资金',
    items: [
      {
        dim: '主力资金净流入（当日/5日/20日）',
        sources: ['东方财富 push2his fflow'],
        cross: false,
        official: false,
        limit: '东财按成交单笔金额分类自算，不同平台口径可能不同',
      },
      {
        dim: '四大单拆分（超大/大/中/小）',
        sources: ['东方财富 fflow'],
        cross: false,
        official: false,
        limit: '同上，分类阈值由数据源定义',
      },
      {
        dim: '龙虎榜席位',
        sources: ['东方财富 datacenter RPT_BILLBOARD_DAILYDETAILSBUY'],
        cross: false,
        official: true,
        cross_note: '龙虎榜本身是交易所披露信息，经东财转载',
        limit: '只有上榜日的明细，未上榜日无数据',
      },
      {
        dim: '宽基 ETF 成交额 / 外盘内盘',
        sources: ['腾讯财经', '东方财富 kline（20 日均额）'],
        cross: true,
        cross_note: '两源分别取实时额与均额，做同时点对齐后相除',
        official: false,
        limit: '「主动净买入」是逐笔方向推算，不是资金净流入；汇金持仓名单已停止披露',
      },
    ],
  },
  {
    group: '基本面',
    items: [
      {
        dim: '财务指标（ROE/毛利/负债/增速）',
        sources: ['东方财富 datacenter F10'],
        cross: false,
        official: true,
        cross_note: '数据源头是上市公司定期报告，东财做结构化',
        limit: 'ROE 按报表类型年化处理；单季数据不代表全年',
      },
      {
        dim: '估值历史分位（PE/PB）',
        sources: ['东方财富 datacenter'],
        cross: false,
        official: false,
        limit: '分位窗口默认 3 年，窗口内口径由数据源决定',
      },
      {
        dim: '十大股东 / 主营构成',
        sources: ['东方财富 datacenter F10'],
        cross: false,
        official: true,
        limit: '最新报告期，有披露滞后',
      },
      {
        dim: '限售解禁',
        sources: ['东方财富 datacenter RPT_LIFT_STAGE'],
        cross: false,
        official: true,
        limit: '只覆盖未来 12 个月；历史解禁需另查',
      },
      {
        dim: '券商研报评级 / 预测 EPS',
        sources: ['东方财富 reportapi'],
        cross: false,
        official: false,
        limit: '只有标题、评级、机构与预测值，没有研报正文',
      },
    ],
  },
  {
    group: '市场',
    items: [
      {
        dim: '涨停 / 跌停 / 炸板池',
        sources: ['东方财富 push2ex'],
        cross: false,
        official: false,
        cross_note: '交易所披露涨停信息，东财聚合',
        limit: '盘中实时变动，历史需按日期逐个取',
      },
      {
        dim: '行业板块涨跌与主力',
        sources: ['东方财富 push2 clist'],
        cross: false,
        official: false,
        limit: '东财行业分类，与申万/中信分类不完全一致',
      },
      {
        dim: '板块成分股',
        sources: ['东方财富 clist'],
        cross: false,
        official: false,
        limit: '成分股由东财维护，非官方指数成分',
      },
    ],
  },
  {
    group: '消息面',
    items: [
      {
        dim: '公司 / 行业 / 政策新闻',
        sources: ['东方财富新闻搜索 search-api-web'],
        cross: false,
        official: false,
        limit: '只有标题与正文片段（截断 200 字）；政策类是关键词命中，不判断利好利空',
      },
      {
        dim: '股吧网友观点（舆情）',
        sources: ['东方财富股吧 guba.eastmoney.com'],
        cross: false,
        official: false,
        limit: '只有东财股吧一个来源；雪球被 WAF 拦截、同花顺无公开接口，均未接入。网友观点不代表事实',
      },
      {
        dim: '公告',
        sources: ['东方财富 np-anotice-stock'],
        cross: false,
        official: true,
        cross_note: '源头为交易所披露，东财转载',
        limit: '只有标题与类型，没有公告正文',
      },
    ],
  },
];

/** 明确没有接入的数据源 */
export const NOT_CONNECTED = [
  { name: '同花顺', reason: '已实测：股吧路径 404，无公开稳定接口，未接入' },
  { name: '雪球', reason: '已实测：请求被阿里云 WAF 拦截，无法抓取，未接入' },
  { name: '微博 / 大 V 观点', reason: '没有任何接入。观点类信息无法交叉验证，也就无法量化' },
  { name: '股吧 / 论坛帖子', reason: '同上，未接入' },
  { name: '研报正文', reason: '只有标题与评级，正文需付费授权' },
  { name: '公告全文', reason: '只有标题，正文未接入' },
  { name: '政策原文库', reason: '没有政策数据库，只做新闻关键词匹配' },
  { name: '股权质押 / 司法风险', reason: '接口口径未打通，宁可不显示也不猜' },
  { name: 'Level-2 逐笔委托', reason: '需付费行情授权' },
  { name: '北向资金实时', reason: '2024-08 起监管取消盘中实时披露' },
];

/** 交叉验证总览 */
export const CROSS_VALIDATION_SUMMARY = {
  total_dimensions: SOURCE_REGISTRY.reduce((a, g) => a + g.items.length, 0),
  cross_validated: SOURCE_REGISTRY.reduce((a, g) => a + g.items.filter((i) => i.cross).length, 0),
  official_sourced: SOURCE_REGISTRY.reduce((a, g) => a + g.items.filter((i) => i.official).length, 0),
  note: '「官方」指数据源头来自交易所或上市公司披露（经第三方转载），不代表我们与交易所直连',
};

export function getSourceRegistry() {
  return {
    ok: true,
    registry: SOURCE_REGISTRY,
    not_connected: NOT_CONNECTED,
    summary: CROSS_VALIDATION_SUMMARY,
    honesty: [
      '所有数据来自腾讯财经 / 东方财富的公开接口，没有交易所直连，也没有付费授权数据',
      '只有行情的价格/涨跌幅/最高/最低做了真正的双源交叉验证，其他维度都是单源',
      '同花顺、雪球、微博大 V、股吧帖子：全部没有接入',
      '任何标注「无数据」的维度就是真的没有，不用常识补',
    ],
  };
}
