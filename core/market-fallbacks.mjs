/** Explicit alternate sources. Missing history/fund-flow stays null, never zero. */
const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' };
async function fetchText(url, encoding = 'utf-8') {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return new TextDecoder(encoding).decode(await r.arrayBuffer());
}
const finite = x => x !== '' && x != null && Number.isFinite(Number(x)) ? Number(x) : null;
export async function fetchTencentBars(code, count = 160) {
  const symbol = /^(sh|sz|bj)\d{6}$/.test(code) ? code : (/^[69]/.test(code) ? 'sh' : /^(43|82|83|87|88|92)/.test(code) ? 'bj' : 'sz') + code;
  const j = JSON.parse(await fetchText('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + symbol + ',day,,,' + count + ',qfq'));
  const rows = j.data?.[symbol]?.qfqday || j.data?.[symbol]?.day;
  if (!Array.isArray(rows) || !rows.length) throw new Error('腾讯历史K线为空');
  return rows.map(r => ({ date:r[0],open:finite(r[1]),close:finite(r[2]),high:finite(r[3]),low:finite(r[4]),volume:finite(r[5]) === null ? null : Number(r[5])*100,amount:null })).filter(r=>[r.open,r.close,r.high,r.low].every(Number.isFinite));
}
export function parseTencentMinutes(j, symbol) {
  const block = j.data?.[symbol], payload = block?.data;
  if (!Array.isArray(payload?.data) || !payload.date) throw new Error('腾讯指数分时为空');
  let previousVolume = 0, previousAmount = 0;
  const points = payload.data.map(line => {
    const [time, price, volume, amount] = line.split(' ');
    const totalVolume = finite(volume), totalAmount = finite(amount);
    const r = { t:payload.date + ' ' + time.slice(0,2)+':'+time.slice(2,4), close:finite(price), high:finite(price),low:finite(price),volume:totalVolume === null ? null : Math.max(0,totalVolume-previousVolume),amount:totalAmount === null ? null : Math.max(0,totalAmount-previousAmount),avg:null };
    if (totalVolume !== null) previousVolume=totalVolume;
    if (totalAmount !== null) previousAmount=totalAmount;
    return r;
  }).filter(p=>p.close>0);
  if (!points.length) throw new Error('腾讯分时无有效价格');
  const quote = block.qt?.[symbol];
  return { ok:true,source:'tencent',degraded:true,trade_date:payload.date,pre_close:Array.isArray(quote)?finite(quote[4]):null,points };
}
export async function fetchTencentIndex(code) {
  const symbol = /^000/.test(code) ? 'sh'+code : 'sz'+code;
  const j = JSON.parse(await fetchText('https://web.ifzq.gtimg.cn/appstock/app/minute/query?code='+symbol));
  return { ...parseTencentMinutes(j,symbol), code };
}
export function parseSinaIndustries(text) {
  const match = text.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!match) throw new Error('新浪行业响应格式不符');
  const data = JSON.parse(match[1]);
  return Object.values(data).map(raw=>{
    const a=String(raw).split(',');
    return {code:a[0],name:a[1],kind:'industry',r1:finite(a[5]),r5:null,r10:null,r60:null,main1:null,main1_ratio:null,main5:null,main5_ratio:null,main10:null,main10_ratio:null,up:null,down:null,leader:a[8]?{code:a[8].replace(/^(sh|sz)/,''),name:a[12]||a[8]}:null,source:'sina'};
  }).filter(b=>b.name&&Number.isFinite(b.r1));
}
export async function fetchSinaIndustries() {
  return parseSinaIndustries(await fetchText('https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php','gb18030'));
}
export async function fetchSinaUniverse() {
  const base='https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/';
  const countText=await fetchText(base+'Market_Center.getHQNodeStockCount?node=hs_a');
  const total=Number(JSON.parse(countText));
  if (!(total>1000&&total<20000)) throw new Error('新浪市场总数异常');
  const pages=Math.ceil(total/100), rows=[];
  let failed=0;
  for(let start=1;start<=pages;start+=4){
    const result=await Promise.all(Array.from({length:Math.min(4,pages-start+1)},(_,i)=>fetchText(base+'Market_Center.getHQNodeData?page='+(start+i)+'&num=100&sort=symbol&asc=1&node=hs_a&symbol=').then(JSON.parse).catch(()=>{failed++;return [];})));
    result.forEach(x=>{if(Array.isArray(x))rows.push(...x);else failed++;});
  }
  const items=[...new Map(rows.filter(r=>/^\d{6}$/.test(r.code)).map(r=>[r.code,{code:r.code,name:r.name,price:finite(r.trade),pct:finite(r.changepercent),amount:finite(r.amount),turnover:finite(r.turnoverratio),pe:finite(r.per),float_cap:finite(r.nmc)===null?null:Number(r.nmc)*10000}])).values()];
  if (!items.length) throw new Error('新浪全市场名录为空');
  return {items,source:'sina',expected:total,failed_pages:failed,coverage:items.length/total};
}
