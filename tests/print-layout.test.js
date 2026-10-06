import test from 'node:test';
import assert from 'node:assert/strict';
import { slipPages } from '../src/print-layout.js';

test('A4 slips use exact groups of twenty without an empty trailing page', () => {
  for (const count of [0, 1, 19, 20, 21, 40, 108, 300]) {
    const slips=Array.from({length:count}, (_, i)=>({number:i+1}));
    const pages=slipPages(slips);
    assert.equal(pages.length,Math.ceil(count/20));
    assert.deepEqual(pages.flat(),slips);
    assert.ok(pages.every(page=>page.length>0&&page.length<=20));
  }
});
