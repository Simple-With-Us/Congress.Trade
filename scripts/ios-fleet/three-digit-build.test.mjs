import test from 'node:test';
import assert from 'node:assert/strict';
import {nextThreeDigitBuild as next} from './three-digit-build.mjs';
const input={platform:'IOS',trainBuilds:[],allPlatformBuilds:[],complete:true};
test('empty train starts at smallest three-digit integer',()=>assert.equal(next(input),'100'));
test('dotted target train can move to higher integer without equality',()=>assert.equal(next({...input,trainBuilds:['0.1.0','1.1.2']}),'100'));
test('strictly exceeds target train, including expired history',()=>assert.equal(next({...input,trainBuilds:['238','239']}),'240'));
test('iOS floor only uses target train, not old timestamp on another train',()=>assert.equal(next({...input,allPlatformBuilds:['202610180127']}),'100'));
test('macOS old timestamp cannot fit ###',()=>assert.throws(()=>next({...input,platform:'MAC_OS',allPlatformBuilds:['202610180127']}),/three-digit build unavailable/));
test('999 exhausted, no wrap or silent alternative',()=>assert.throws(()=>next({...input,trainBuilds:['999']}),/unavailable/));
test('998 can use999',()=>assert.equal(next({...input,trainBuilds:['998']}),'999'));
test('integer component above999 is unsafe even if expired',()=>assert.throws(()=>next({...input,trainBuilds:['2382']}),/unavailable/));
test('missing/incomplete/malformed inventory refuses',()=>{
 for(const patch of [{complete:false},{platform:'TV_OS'},{trainBuilds:['NaN']},{trainBuilds:[null]},{allPlatformBuilds:null}]) assert.throws(()=>next({...input,...patch}));
});

test('iOS validates unused cross-train inventory without applying its floor',()=>{
 for(const value of [null,'NaN','1.2.3.4',42,'']) assert.throws(()=>next({...input,allPlatformBuilds:[value]}),/malformed/);
 assert.equal(next({...input,allPlatformBuilds:['202610180127']}),'100');
});
