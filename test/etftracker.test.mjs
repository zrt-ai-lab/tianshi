import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeTrackerLive, trackerShapeAt} from '../core/etftracker.mjs';
const snapshot={trade_date:'20261106',generated_at:'2026-11-06 18:21',items:[{group:'core',code:'510300',name:'ETF',amount_yi:1,avg20_yi:10,outer_lots:1,inner_lots:1,date:'20261106',shape:[['09:30',0.01],['11:30',0.5],['15:00',1]]}]};
function quote(time){const a=Array(80).fill('0');a[2]='510300';a[7]='60';a[8]='40';a[30]=time;a[37]='100000';return 'v_sh510300="'+a.join('~')+'";';}
test('new quote replaces snapshot date and turnover, baseline provenance retained',()=>{const r=mergeTrackerLive(snapshot,quote('20261109161403'));assert.equal(r.trade_date,'20261109');assert.equal(r.ratio,1);assert.equal(r.active_net_yi,2);assert.equal(r.baseline_trade_date,'20261106');assert.equal(r.mode,'source_live_close');});
test('lunch turnover compares to historical 11:30 fraction',()=>{const r=mergeTrackerLive(snapshot,quote('20261109120000'));assert.equal(r.ratio,2);assert.equal(r.mode,'source_live_aligned');});
test('incomplete quotes fail rather than mix dates',()=>assert.throws(()=>mergeTrackerLive(snapshot,''),/不完整/));
test('missing intraday curve stays unavailable',()=>assert.equal(trackerShapeAt([], '10:00'),null));
