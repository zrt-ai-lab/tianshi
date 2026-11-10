import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSectorLadders} from '../core/ladder-sectors.mjs';
const stock=(code,n,industry='电力')=>({code,name:code,boards:n,industry,first_seal:93000,broken:0});
test('industry counts and 1..7 board ladder, promotion follows same stock',()=>{const r=buildSectorLadders([stock('a',2),stock('b',1),stock('c',3)],[stock('a',1),stock('z',1)],null)[0];assert.equal(r.count,3);assert.equal(r.levels.length,7);assert.equal(r.promotion[0].rate,50);assert.equal(r.probability,null)});
test('do not fuzzy-join different industry names or invent probability',()=>{const r=buildSectorLadders([stock('a',2)],[],{boards:[{name:'电力设备',kind:'industry',main1:100}]})[0];assert.equal(r.rotation,null);assert.equal(r.probability,null);assert.ok(r.risks.some(x=>x.includes('未精确匹配')))});
test('missing prior pool never implies zero observed rate',()=>{const r=buildSectorLadders([stock('a',2)],[stock('a',1)],null,{previousAvailable:false})[0];assert.equal(r.promotion[0].rate,null)});
test('higher boards beyond 7 retained',()=>{assert.equal(buildSectorLadders([stock('a',9)],[],null)[0].levels.length,9)});
