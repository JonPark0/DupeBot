import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseAction } from '../src/dupe/decide.ts';
import { BoundedQueue } from '../src/semantic/queue.ts';

const base = { mode: 'forward', kind: 'exact', sameChannel: false, authorCanView: true, everyoneCanView: true } as const;

test('forward or reply as configured when the original is public', () => {
  assert.equal(chooseAction(base), 'forward');
  assert.equal(chooseAction({ ...base, mode: 'reply' }), 'reply');
  assert.equal(chooseAction({ ...base, mode: 'react' }), 'react');
});

test('an original in a private channel is never copied or linked', () => {
  assert.equal(chooseAction({ ...base, everyoneCanView: false }), 'react');
  assert.equal(chooseAction({ ...base, authorCanView: false }), 'react');
  assert.equal(chooseAction({ ...base, mode: 'reply', everyoneCanView: false }), 'react');
  // same channel: whoever sees the repost already sees the original
  assert.equal(chooseAction({ ...base, sameChannel: true, everyoneCanView: false, authorCanView: false }), 'forward');
});

test('a semantic match gets a link reply, never a forward', () => {
  assert.equal(chooseAction({ ...base, kind: 'semantic' }), 'reply');
  assert.equal(chooseAction({ ...base, kind: 'semantic', mode: 'react' }), 'react');
  assert.equal(chooseAction({ ...base, kind: 'semantic', everyoneCanView: false }), 'react');
});

test('sticker mode replies with the sticker and a link, or the sticker alone when the original is private', () => {
  const sticker = { ...base, mode: 'sticker', hasSticker: true } as const;
  assert.equal(chooseAction(sticker), 'sticker');
  assert.equal(chooseAction({ ...sticker, everyoneCanView: false }), 'sticker-only');
  assert.equal(chooseAction({ ...sticker, authorCanView: false }), 'sticker-only');
  assert.equal(chooseAction({ ...sticker, sameChannel: true, everyoneCanView: false }), 'sticker');
});

test('sticker mode without a usable sticker falls back to a link reply', () => {
  assert.equal(chooseAction({ ...base, mode: 'sticker', hasSticker: false }), 'reply');
  assert.equal(chooseAction({ ...base, mode: 'sticker' }), 'reply');
  assert.equal(chooseAction({ ...base, mode: 'sticker', everyoneCanView: false }), 'react');
});

test('a semantic match in sticker mode keeps the emoji and link reply', () => {
  assert.equal(chooseAction({ ...base, mode: 'sticker', kind: 'semantic', hasSticker: true }), 'reply');
  assert.equal(chooseAction({ ...base, mode: 'sticker', kind: 'semantic', hasSticker: true, everyoneCanView: false }), 'react');
});

test('the semantic queue runs one job at a time and drops jobs past the backlog', async () => {
  let running = 0;
  let maxRunning = 0;
  const done: number[] = [];
  const queue = new BoundedQueue<number>(async (n) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    done.push(n);
    running--;
  }, 2);
  const accepted = [1, 2, 3, 4].map((n) => queue.push(n));
  await queue.idle();
  assert.equal(maxRunning, 1);
  assert.equal(queue.dropped, accepted.filter((ok) => !ok).length);
  assert.ok(queue.dropped >= 1);
  assert.deepEqual(done, [1, 2, 3, 4].filter((_, i) => accepted[i]));
});
