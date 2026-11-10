import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyRegulatoryNotice,summarizeRegulatory} from '../core/event-context.mjs';
test('ignore generic corporate governance and employee-plan checks',()=>{assert.equal(classifyRegulatoryNotice('关于员工持股计划事项的核查意见'),null);assert.equal(classifyRegulatoryNotice('内部控制及风险管理制度'),null)});
test('abnormal trading notice does not imply confirmed monitoring or expiry',()=>{const r=summarizeRegulatory([{title:'九阳股份:股票交易异常波动公告',notice_date:'2026-10-22',symbol:'002242',art_code:'AN202610211830769731'}],new Date('2026-11-10T12:00:00+08:00'));assert.equal(r.notices.length,1);assert.equal(r.monitoring_confirmed,false);assert.equal(r.expiry,null);assert.ok(r.notices[0].url.endsWith('.html'))});
test('no notices never means no regulation',()=>{const r=summarizeRegulatory([],new Date());assert.match(r.caveat,/未找到也不代表未被监管/)});
