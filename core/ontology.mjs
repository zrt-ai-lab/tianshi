/**
 * 产业链本体：行业 / 概念 → 产业链环节 → 海外映射标的 → 驱动因素
 *
 * 用途：给「这只票为什么涨跌」提供可下钻的候选驱动链。
 * 本体只回答「理论上可能有关」，**是否真的有关由 lib/rootcause.mjs 用历史数据实测**，
 * 实测联动弱的环节会被标注为「本体关联、数据未证实」，不当成根因。
 *
 * 维护原则：
 *   - 海外标的只放流动性好、产业地位明确的龙头或行业 ETF
 *   - secid 采用东方财富格式（105 纳斯达克 / 106 纽交所 / 107 美交所 / 100 指数），均已实测可取日 K
 *   - 匹配用股票所属的东财行业名与概念板块名，关键词宽松匹配
 */

/** 海外标的字典（secid → 中文说明） */
export const OVERSEAS = {
  NVDA: { secid: '105.NVDA', name: '英伟达', role: 'AI 算力 GPU 龙头' },
  AMD: { secid: '105.AMD', name: 'AMD', role: 'CPU / GPU' },
  AVGO: { secid: '105.AVGO', name: '博通', role: 'AI 定制芯片 / 网络芯片' },
  TSM: { secid: '106.TSM', name: '台积电', role: '晶圆代工龙头' },
  ASML: { secid: '105.ASML', name: '阿斯麦', role: '光刻机' },
  AMAT: { secid: '105.AMAT', name: '应用材料', role: '半导体设备' },
  LRCX: { secid: '105.LRCX', name: '泛林', role: '刻蚀 / 沉积设备' },
  MU: { secid: '105.MU', name: '美光', role: '存储芯片 DRAM / NAND' },
  QCOM: { secid: '105.QCOM', name: '高通', role: '手机 SoC' },
  INTC: { secid: '105.INTC', name: '英特尔', role: 'CPU / 代工' },
  ARM: { secid: '105.ARM', name: 'ARM', role: '芯片架构授权' },
  SMH: { secid: '105.SMH', name: '半导体 ETF(SMH)', role: '美股半导体整体' },
  ANET: { secid: '106.ANET', name: 'Arista', role: '数据中心交换机' },
  COHR: { secid: '106.COHR', name: 'Coherent', role: '光模块 / 光器件' },
  MSFT: { secid: '105.MSFT', name: '微软', role: '云与 AI 资本开支' },
  GOOGL: { secid: '105.GOOGL', name: '谷歌', role: '云与 AI 资本开支' },
  META: { secid: '105.META', name: 'Meta', role: 'AI 资本开支' },
  AAPL: { secid: '105.AAPL', name: '苹果', role: '消费电子链主' },
  TSLA: { secid: '105.TSLA', name: '特斯拉', role: '电动车 / 机器人' },
  ALB: { secid: '106.ALB', name: '雅宝', role: '锂资源' },
  FSLR: { secid: '105.FSLR', name: 'First Solar', role: '美股光伏' },
  ENPH: { secid: '105.ENPH', name: 'Enphase', role: '光伏逆变器' },
  FCX: { secid: '106.FCX', name: '自由港', role: '铜矿龙头' },
  SCCO: { secid: '106.SCCO', name: '南方铜业', role: '铜矿' },
  NEM: { secid: '106.NEM', name: '纽蒙特', role: '黄金矿业' },
  GLD: { secid: '107.GLD', name: '黄金 ETF', role: '金价' },
  XOM: { secid: '106.XOM', name: '埃克森美孚', role: '油价 / 能源' },
  LLY: { secid: '106.LLY', name: '礼来', role: '创新药 / GLP-1' },
  NVO: { secid: '106.NVO', name: '诺和诺德', role: 'GLP-1 减肥药' },
  XBI: { secid: '107.XBI', name: '生物科技 ETF', role: '美股创新药整体' },
  NDX: { secid: '100.NDX', name: '纳斯达克 100', role: '美股科技整体' },
  SPX: { secid: '100.SPX', name: '标普 500', role: '美股整体风险偏好' },
};

/**
 * 产业链节点
 * match：命中任一关键词即归入（对 行业名 + 概念板块名 做包含匹配）
 * chain：产业链环节说明
 * drivers：海外映射标的（按重要性排序，最多取前 4 个参与实测）
 * factors：非价格驱动因素（政策 / 周期 / 事件），供 AI 推理时检查
 */
export const CHAIN_NODES = [
  {
    key: 'semi_mfg', name: '半导体 · 制造与代工',
    match: ['晶圆', '代工', '中芯', '集成电路制造'],
    chain: '芯片设计 → 晶圆代工 → 封测；代工厂景气取决于先进制程需求与产能利用率',
    drivers: ['TSM', 'SMH', 'NVDA', 'INTC'],
    factors: ['台积电月度营收与资本开支', '美国出口管制政策', '国产替代采购节奏', '产能利用率'],
  },
  {
    key: 'semi_equip', name: '半导体 · 设备与材料',
    match: ['半导体设备', '光刻', '刻蚀', '半导体材料', '电子化学品', '光刻胶', '靶材', '硅片'],
    chain: '晶圆厂资本开支 → 设备 / 材料订单；国产化率提升是主要变量',
    drivers: ['ASML', 'AMAT', 'LRCX', 'SMH'],
    factors: ['全球晶圆厂资本开支', '设备出口管制清单', '国产设备验证与订单', '大基金投资'],
  },
  {
    key: 'semi_storage', name: '半导体 · 存储',
    match: ['存储', 'DRAM', 'NAND', '闪存'],
    chain: '存储价格周期（DRAM / NAND 合约价）→ 存储模组与主控利润',
    drivers: ['MU', 'SMH', 'NVDA'],
    factors: ['DRAM / NAND 合约价', 'HBM 需求', '原厂减产或扩产'],
  },
  {
    key: 'semi_design', name: '半导体 · 设计',
    match: ['芯片', '半导体', '集成电路', '国产芯片', '模拟芯片', 'MCU', 'GPU', 'CPU'],
    chain: '下游需求（手机 / 汽车 / 工业 / AI）→ 芯片设计公司出货与库存',
    drivers: ['SMH', 'NVDA', 'QCOM', 'AMD'],
    factors: ['下游库存周期', '国产替代', '消费电子出货量'],
  },
  {
    key: 'ai_compute', name: 'AI 算力 · 服务器与网络',
    match: ['算力', '服务器', '数据中心', 'AI', '人工智能', '液冷', 'IDC', '交换机', 'PCB', '铜缆'],
    chain: '海外云厂资本开支 → GPU / ASIC → 服务器、交换机、PCB、电源、液冷',
    drivers: ['NVDA', 'AVGO', 'ANET', 'MSFT'],
    factors: ['北美四大云厂资本开支指引', '英伟达财报与指引', '国内智算中心招标'],
  },
  {
    key: 'optical', name: 'AI 算力 · 光模块',
    match: ['光模块', 'CPO', '光通信', '光器件', '光芯片'],
    chain: 'AI 集群互联 → 800G / 1.6T 光模块需求',
    drivers: ['COHR', 'NVDA', 'AVGO', 'ANET'],
    factors: ['北美云厂资本开支', '1.6T 放量节奏', '英伟达网络业务'],
  },
  {
    key: 'consumer_elec', name: '消费电子',
    match: ['消费电子', '苹果', '果链', '手机', 'AI眼镜', 'VR', 'AR', '可穿戴'],
    chain: '品牌新品周期 → 组装 / 结构件 / 声学 / 光学供应链',
    drivers: ['AAPL', 'QCOM', 'META'],
    factors: ['苹果新品与销量', '手机换机周期', '国补政策'],
  },
  {
    key: 'ev_robot', name: '新能源车与机器人',
    match: ['汽车', '新能源车', '整车', '汽车零部件', '人形机器人', '机器人', '减速器', '丝杠', '智能驾驶'],
    chain: '整车销量 / 机器人量产 → 零部件、执行器、传感器',
    drivers: ['TSLA', 'NVDA'],
    factors: ['月度汽车销量', '特斯拉 Optimus 进展', '以旧换新政策'],
  },
  {
    key: 'lithium', name: '锂电与锂资源',
    match: ['锂', '电池', '储能', '固态电池', '正极', '负极', '电解液', '隔膜'],
    chain: '锂价 → 电池材料成本 → 电池厂利润；储能需求是新变量',
    drivers: ['ALB', 'TSLA'],
    factors: ['碳酸锂期货价格', '储能装机', '电动车销量'],
  },
  {
    key: 'solar', name: '光伏',
    match: ['光伏', '硅料', '组件', '逆变器', 'TOPCon', 'HJT'],
    chain: '硅料价格 → 硅片 / 电池 / 组件；反内卷限产是主要变量',
    drivers: ['FSLR', 'ENPH'],
    factors: ['多晶硅价格', '行业限产政策', '海外贸易壁垒'],
  },
  {
    key: 'copper', name: '有色 · 铜铝工业金属',
    match: ['铜', '铝', '工业金属', '有色', '锌', '镍'],
    chain: '全球制造业与电网需求 → 金属价格 → 冶炼 / 加工利润',
    drivers: ['FCX', 'SCCO', 'SPX'],
    factors: ['LME 铜铝价格', '美元指数', '国内电网投资'],
  },
  {
    key: 'gold', name: '贵金属',
    match: ['黄金', '贵金属', '白银'],
    chain: '实际利率与避险需求 → 金价 → 金矿利润',
    drivers: ['GLD', 'NEM'],
    factors: ['美联储利率预期', '美元指数', '央行购金'],
  },
  {
    key: 'oil', name: '石油与油服',
    match: ['石油', '油服', '油气', '天然气', '炼化'],
    chain: '原油价格 → 上游开采与油服利润',
    drivers: ['XOM'],
    factors: ['布伦特原油价格', 'OPEC+ 产量', '地缘冲突'],
  },
  {
    key: 'biotech', name: '创新药',
    match: ['创新药', '生物医药', '医药', 'CXO', '减肥药', 'GLP', '生物制品'],
    chain: '海外授权（BD）与临床数据 → 估值重估；美股生物科技风险偏好联动',
    drivers: ['XBI', 'LLY', 'NVO'],
    factors: ['对外授权交易', '临床数据读出', '集采与医保谈判'],
  },
];

/** 无明显海外映射的行业：明确告诉用户驱动在国内，避免硬凑 */
export const DOMESTIC_ONLY = [
  { match: ['白酒', '酿酒', '食品饮料'], reason: '消费税、渠道库存与国内需求驱动' },
  { match: ['银行', '保险', '证券', '多元金融'], reason: '国内利率、信贷与资本市场成交驱动' },
  { match: ['电力', '水电', '火电', '核电', '公用事业'], reason: '电价、来水与发电量驱动' },
  { match: ['房地产', '建筑', '水泥', '建材'], reason: '国内地产与基建政策驱动' },
  { match: ['中药', '医疗服务'], reason: '国内医保与消费驱动' },
];

/**
 * 根据行业名与概念板块名匹配本体节点
 * @param {string} industry 东财行业名（如「半导体」「工业金属」）
 * @param {string[]} concepts 概念板块名列表
 * @returns {{nodes:object[], domestic:object|null}}
 */
export function matchOntology(industry, concepts = []) {
  const ind = String(industry ?? '');
  const hits = (n, text) => n.match.filter((k) => text.includes(k)).length;
  // 行业优先：所属行业命中的节点才是主链路；概念只在行业没命中时作补充
  const byIndustry = CHAIN_NODES.map((n) => ({ n, s: hits(n, ind) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s).map((x) => ({ ...x.n, via: 'industry' }));
  const domestic = DOMESTIC_ONLY.find((d) => d.match.some((k) => ind.includes(k))) ?? null;
  let nodes = byIndustry;
  // 同一大类内用概念细化：行业只说「半导体」时，概念里的「中芯概念」「存储芯片」能定位到具体环节
  if (nodes.length) {
    const families = new Set(nodes.map((n) => n.key.split('_')[0]));
    const ctext = concepts.join('|');
    const refine = CHAIN_NODES.filter((n) => families.has(n.key.split('_')[0]) && !nodes.some((x) => x.key === n.key))
      .map((n) => ({ n, s: hits(n, ctext) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
      .map((x) => ({ ...x.n, via: 'concept' }));
    nodes = [...refine, ...nodes];
  }
  if (!nodes.length && !domestic) {
    const ctext = concepts.join('|');
    nodes = CHAIN_NODES.map((n) => ({ n, s: hits(n, ctext) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s).map((x) => ({ ...x.n, via: 'concept' }));
  }
  // 半导体细分优先：命中制造 / 设备 / 存储时去掉泛化的「设计」节点
  if (nodes.some((n) => ['semi_mfg', 'semi_equip', 'semi_storage'].includes(n.key))) {
    nodes = nodes.filter((n) => n.key !== 'semi_design');
  }
  return { nodes: nodes.slice(0, 2), domestic: nodes.length ? null : domestic };
}
