import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSharedBuild as next} from './shared-build.mjs';
const STAMP = '202610290000';
const input = {iosBuilds: [], macBuilds: [], complete: true, mergeStamp: STAMP};
test('fresh app plans the merge stamp itself', () => {
  assert.deepEqual(next(input), {build: '202610290000'});
});
test('existing builds below the stamp leave the stamp', () => {
  assert.deepEqual(next({...input, iosBuilds: ['1000']}), {build: '202610290000'});
  assert.deepEqual(next({...input, iosBuilds: ['2394'], macBuilds: ['1200']}), {build: '202610290000'});
  assert.deepEqual(next({...input, iosBuilds: ['202610190645']}), {build: '202610290000'});
  assert.deepEqual(next({...input, macBuilds: ['202610190645']}), {build: '202610290000'});
});
test('an existing build at the stamp goes one up, so a rebuild of the same commit still rises', () => {
  assert.deepEqual(next({...input, iosBuilds: ['202610290000']}), {build: '202610290001'});
  assert.deepEqual(next({...input, macBuilds: ['202610290000']}), {build: '202610290001'});
});
test('an existing build above the stamp goes one up', () => {
  assert.deepEqual(next({...input, iosBuilds: ['209912312359']}), {build: '209912312360'});
});
test('iOS timestamp builds count now', () => {
  assert.deepEqual(
    next({...input, mergeStamp: '202610180000', iosBuilds: ['202610190645']}),
    {build: '202610190646'}
  );
});
test('a mac-only higher build wins', () => {
  assert.deepEqual(next({...input, macBuilds: ['202610290005']}), {build: '202610290006'});
});
test('the plan is the max across iOS, macOS and floors', () => {
  assert.deepEqual(
    next({...input, iosBuilds: ['202610290003'], macBuilds: ['202610290005'], extraFloors: [202610290001]}),
    {build: '202610290006'}
  );
  assert.deepEqual(
    next({...input, iosBuilds: ['202610290003'], macBuilds: ['202610290005'], extraFloors: [202610290009]}),
    {build: '202610290010'}
  );
});
test('dotted builds count by their first component on either platform', () => {
  assert.deepEqual(next({...input, iosBuilds: ['1.1.2']}), {build: '202610290000'});
  assert.deepEqual(
    next({...input, mergeStamp: '202610180000', macBuilds: ['202610190645.1']}),
    {build: '202610190646'}
  );
});
test('extra floors accept plain integers and numeric strings', () => {
  assert.deepEqual(next({...input, extraFloors: [1500]}), {build: '202610290000'});
  assert.deepEqual(next({...input, extraFloors: [202610290005]}), {build: '202610290006'});
  assert.deepEqual(next({...input, extraFloors: ['202610290005']}), {build: '202610290006'});
  assert.deepEqual(next({...input, extraFloors: ['999999999999999999']}), {build: '1000000000000000000'});
});
test('no floor and no cap', () => {
  assert.deepEqual(next({...input, iosBuilds: ['101']}), {build: '202610290000'});
  assert.deepEqual(next({...input, iosBuilds: ['9999']}), {build: '202610290000'});
  assert.deepEqual(next({...input, macBuilds: ['9999']}), {build: '202610290000'});
  assert.deepEqual(next({...input, extraFloors: [9999]}), {build: '202610290000'});
  assert.deepEqual(
    next({...input, mergeStamp: '999999999999', iosBuilds: ['999999999999']}),
    {build: '1000000000000'}
  );
});
test('malformed inventory throws before computing', () => {
  for (const bad of [null, 'NaN', '1.2.3.4', 42, '', ' 1000', 'v1']) {
    assert.throws(() => next({...input, iosBuilds: [bad]}), /malformed build inventory/);
    assert.throws(() => next({...input, macBuilds: [bad]}), /malformed build inventory/);
  }
  for (const bad of [-1, 1.5, NaN, 'x', '', null, '1.5']) {
    assert.throws(() => next({...input, extraFloors: [bad]}), /malformed build inventory/);
  }
  // A malformed entry is reported even when a higher build would also apply.
  assert.throws(() => next({...input, iosBuilds: ['209912312359', 'NaN']}), /malformed build inventory/);
});
test('a bad merge stamp throws', () => {
  for (const bad of [undefined, null, 202610290000, '', '20261029000', '2026102900000', '012345678901', '2026-10-29 00:00', 'abcdefghijkl']) {
    assert.throws(() => next({...input, mergeStamp: bad}), /malformed merge stamp/);
  }
});
test('incomplete inventory refuses', () => {
  assert.throws(() => next({...input, complete: false}), /complete build inventory required/);
  assert.throws(() => next({...input, complete: undefined}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
  assert.throws(() => next({macBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: '1000', macBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
});
