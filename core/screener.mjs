/** Focused scans: 主升浪 and 业绩线. Results are ranked observations, not predictions. */
const n=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
export const SCAN_DEFS={
  mainrise:{name:'主升浪扫描',description:'趋势已确立、量能配合、相对强度领先；高位追涨风险单独标出。'},
  earnings:{name:'业绩线扫描',description:'盈利改善、ROE/毛利质量与估值交叉筛选；业绩好不等于股价还便宜。'}
};
export function scoreMainrise(x){
  const reasons=[],risks=[];let score=0;
  if(x.ret60>=55){score+=22;reasons.push('60日涨幅 '+x.ret60+'%，趋势已被市场看见')}else if(x.ret60>=25){score+=12;reasons.push('60日涨幅 '+x.ret60+'%')} 
  if(x.bull_align){score+=18;reasons.push('MA5>MA10>MA20>MA60，多头排列')}
  if(x.breakout){score+=18;reasons.push('站上60日平台高点')}
  if(x.vol_ratio_5_20>=1.25){score+=15;reasons.push('5日量能为20日均量 '+x.vol_ratio_5_20+' 倍')}
  if(x.rs?.excess_20d>=15){score+=15;reasons.push('20日跑赢大盘 '+x.rs.excess_20d+'pp')}
  if(x.fund?.main_5d>0&&x.fund?.main_20d>0){score+=12;reasons.push('主力5日与20日均流入')}
  if(x.pos120>=94){risks.push('位置接近区间顶部，追高风险大')}
  if(x.ret60>=150){risks.push('60日涨幅过大，容易进入高位分歧')}
  if(x.fund?.main_5d<0){risks.push('近5日主力转为流出')}
  const stage=x.pos120>=94?'高位主升':x.ret60>=55?'主升确认':'启动偏强';
  return {score:Math.min(100,score),stage,reasons,risks};
}
export function scoreEarnings(x){
  const reasons=[],risks=[];let score=0;
  if(x.revenue_yoy>=15){score+=20;reasons.push('营收同比 +'+x.revenue_yoy+'%')}else if(x.revenue_yoy>0){score+=10;reasons.push('营收保持增长')}
  if(x.netprofit_yoy>=20){score+=20;reasons.push('净利同比 +'+x.netprofit_yoy+'%')}else if(x.netprofit_yoy>0){score+=10;reasons.push('净利保持增长')}
  if(x.roe>=12){score+=18;reasons.push('ROE '+x.roe+'%，盈利质量较好')}else if(x.roe>=8){score+=9;reasons.push('ROE '+x.roe+'%')}
  if(x.gross_margin>=30){score+=12;reasons.push('毛利率 '+x.gross_margin+'%')}
  if(x.pe_pct!=null&&x.pe_pct<=40){score+=15;reasons.push('PE历史分位 '+x.pe_pct+'%，估值不高')}
  if(x.ret60!=null&&x.ret60<30){score+=10;reasons.push('股价近60日涨幅 '+x.ret60+'%，尚未极端')}
  if(x.revenue_yoy<0||x.netprofit_yoy<0)risks.push('营收或净利同比为负，业绩线不完整');
  if(x.ret60>=80)risks.push('业绩好但股价已大涨，可能提前交易预期');
  if(x.pe_pct>=80)risks.push('估值分位高，业绩增长可能已被定价');
  return {score:Math.min(100,score),reasons,risks,stage:x.ret60>=80?'业绩好但高位':'业绩改善观察'};
}
export function scanFromCards(cards,type,limit=30){
  const fn=type==='earnings'?scoreEarnings:scoreMainrise;
  return cards.map(x=>({...x,scan:fn(x)})).filter(x=>x.scan.score>=45).sort((a,b)=>b.scan.score-a.scan.score).slice(0,limit);
}
