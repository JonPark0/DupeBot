import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageLike } from '../src/detect/collect.ts';
import type { ImageHash } from '../src/detect/image.ts';
import { channelWatched, Detector } from '../src/dupe/detector.ts';
import type { MessageRef } from '../src/store/types.ts';
import { DEFAULT_SETTINGS, MemoryStore } from './memory-store.ts';

const T0 = Date.parse('2026-11-22T00:00:00Z');

function ref(id: string, author: string, minutes: number, channel = 'c1'): MessageRef {
  return { guildId: 'g1', channelId: channel, messageId: id, authorId: author, postedAt: new Date(T0 + minutes * 60_000) };
}

function msg(content: string, extra: Partial<MessageLike> = {}): MessageLike {
  return { content, attachments: [], embeds: [], ...extra };
}

function setup(images: Record<string, ImageHash | null> = {}) {
  const store = new MemoryStore();
  let downloads = 0;
  const detector = new Detector({
    store,
    imageMaxBytes: 1_000_000,
    hashImageUrl: async (url) => {
      downloads++;
      return images[url] ?? null;
    },
  });
  return { store, detector, downloads: () => downloads };
}

async function post(detector: Detector, r: MessageRef, m: MessageLike) {
  const result = await detector.index(r, m);
  return { ...result, match: await detector.findMatch(r, result.fresh, DEFAULT_SETTINGS) };
}

test('the same link from another author matches the first post, after normalization', async () => {
  const { detector } = setup();
  assert.equal((await post(detector, ref('m1', 'alice', 0), msg('https://youtu.be/dQw4w9WgXcQ'))).match, null);
  const second = await post(detector, ref('m2', 'bob', 60), msg('이거 봤어? https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=x'));
  assert.equal(second.match?.reason, 'url');
  assert.equal(second.match?.hit.messageId, 'm1');
  // a third repost still points at the oldest one
  const third = await post(detector, ref('m3', 'carol', 120), msg('https://m.youtube.com/watch?v=dQw4w9WgXcQ'));
  assert.equal(third.match?.hit.messageId, 'm1');
});

test("the author's own repost within the window is ignored, later it is flagged", async () => {
  const { detector } = setup();
  await post(detector, ref('m1', 'alice', 0), msg('https://example.com/a'));
  assert.equal((await post(detector, ref('m2', 'alice', 5), msg('https://example.com/a'))).match, null);
  assert.equal((await post(detector, ref('m3', 'alice', 30), msg('https://example.com/a'))).match?.hit.messageId, 'm1');
});

test('allowlisted content is never flagged', async () => {
  const { detector, store } = setup();
  await post(detector, ref('m1', 'alice', 0), msg('https://example.com/meme'));
  await store.addAllowlist('g1', await store.fingerprintsFor('m1'));
  assert.equal((await post(detector, ref('m2', 'bob', 60), msg('https://example.com/meme'))).match, null);
});

test('images: same file, then a similar picture (dHash within the threshold)', async () => {
  const a: ImageHash = { sha256: 'aaa', dhash: 0b1010n, width: 100, height: 100 };
  const sameFile: ImageHash = { ...a };
  const similar: ImageHash = { sha256: 'bbb', dhash: 0b1010n ^ 0b111n, width: 80, height: 80 }; // 3 bits off
  const unrelated: ImageHash = { sha256: 'ccc', dhash: 0xffff_ffffn, width: 80, height: 80 };
  const { detector } = setup({ 'u/a': a, 'u/a2': sameFile, 'u/sim': similar, 'u/other': unrelated });
  const image = (url: string) => msg('', { attachments: [{ url, contentType: 'image/png', size: 1000 }] });

  assert.equal((await post(detector, ref('m1', 'alice', 0), image('u/a'))).match, null);
  assert.equal((await post(detector, ref('m2', 'bob', 60), image('u/a2'))).match?.reason, 'image');
  assert.equal((await post(detector, ref('m3', 'bob', 61), image('u/sim'))).match?.reason, 'similar-image');
  assert.equal((await post(detector, ref('m4', 'bob', 62), image('u/other'))).match, null);
});

test('an edit or a late embed only reports what is new, and triggers the semantic check once the title arrives', async () => {
  const { detector, downloads } = setup({ 'u/a': { sha256: 'aaa', dhash: 1n, width: 100, height: 100 } });
  const r = ref('m1', 'alice', 0);
  const attachment = { url: 'u/a', contentType: 'image/png', size: 10 };
  const first = await detector.index(r, msg('https://news.example/story', { attachments: [attachment] }));
  assert.equal(first.fresh.length, 2);
  assert.equal(first.semanticLinks.length, 0, 'no preview text yet');

  const withEmbed = msg('https://news.example/story', {
    attachments: [attachment],
    embeds: [{ type: 'article', url: 'https://news.example/story', title: '첫눈', description: '서울에 첫눈' }],
  });
  const update = await detector.index(r, withEmbed);
  assert.equal(update.fresh.length, 0);
  assert.equal(update.semanticLinks.length, 1);
  assert.equal(update.semanticLinks[0].title, '첫눈');
  assert.equal(downloads(), 1, 'the attachment was not downloaded again');

  const again = await detector.index(r, withEmbed);
  assert.equal(again.semanticLinks.length, 0, 'not re-queued on later edits');
});

test('channel include/exclude lists apply to threads through their parent', () => {
  const s = { ...DEFAULT_SETTINGS };
  assert.equal(channelWatched(s, 'c1', null), true);
  assert.equal(channelWatched({ ...s, excludeChannels: ['c1'] }, 'thread', 'c1'), false);
  assert.equal(channelWatched({ ...s, includeChannels: ['c2'] }, 'c1', null), false);
  assert.equal(channelWatched({ ...s, includeChannels: ['c2'] }, 'thread', 'c2'), true);
});

test('a video attachment matches the same file posted earlier, and is downloaded once per URL', async () => {
  const store = new MemoryStore();
  const hashes: Record<string, string> = { 'https://cdn/a.mp4': 'aaa', 'https://cdn/b.mp4': 'aaa', 'https://cdn/c.mp4': 'ccc' };
  let downloads = 0;
  const detector = new Detector({
    store,
    imageMaxBytes: 1_000_000,
    hashImageUrl: async () => null,
    fileMaxBytes: 50_000_000,
    hashFileUrl: async (url) => {
      downloads++;
      return hashes[url] ?? null;
    },
  });
  const video = (url: string, size = 1000) => msg('', { attachments: [{ url, contentType: 'video/mp4', size }] });

  assert.equal((await post(detector, ref('v1', 'alice', 0), video('https://cdn/a.mp4'))).match, null);
  const repost = await post(detector, ref('v2', 'bob', 60), video('https://cdn/b.mp4'));
  assert.equal(repost.match?.reason, 'file');
  assert.equal(repost.match?.hit.messageId, 'v1');
  assert.equal((await post(detector, ref('v3', 'bob', 120), video('https://cdn/c.mp4'))).match, null);

  // an edit re-delivers the same attachment: no second download
  await detector.index(ref('v1', 'alice', 0), video('https://cdn/a.mp4'));
  assert.equal(downloads, 3);
});

test('videos over the size cap, and with videos turned off, are not downloaded', async () => {
  let downloads = 0;
  const make = (fileMaxBytes: number) =>
    new Detector({
      store: new MemoryStore(),
      imageMaxBytes: 1_000_000,
      hashImageUrl: async () => null,
      fileMaxBytes,
      hashFileUrl: async () => {
        downloads++;
        return 'x';
      },
    });
  const big = msg('', { attachments: [{ url: 'https://cdn/big.mp4', contentType: 'video/mp4', size: 2_000 }] });
  await make(1_000).index(ref('b1', 'alice', 0), big);
  await make(0).index(ref('b2', 'alice', 0), big);
  assert.equal(downloads, 0);
});
