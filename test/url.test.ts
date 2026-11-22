import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractUrls, normalizeUrl, urlKey } from '../src/detect/url.ts';

const same: [string, string][] = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc123', 'https://youtu.be/dQw4w9WgXcQ?si=zzz'],
  ['https://youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['https://x.com/someone/status/1234567890?s=20&t=abc', 'https://twitter.com/SomeoneElse/status/1234567890'],
  ['https://fxtwitter.com/a/status/1234567890', 'https://vxtwitter.com/a/status/1234567890/photo/1'],
  ['https://fixupx.com/a/status/1234567890', 'https://mobile.twitter.com/a/status/1234567890'],
  ['https://example.com/news/1?utm_source=x&utm_medium=y&fbclid=1', 'http://EXAMPLE.com/news/1/'],
  ['https://example.com/a?b=2&a=1', 'https://example.com/a?a=1&b=2&gclid=9'],
  ['https://example.com/page#section', 'https://www.example.com/page'],
  ['https://www.instagram.com/p/ABC123/?igsh=xyz', 'https://instagram.com/p/ABC123'],
  ['https://www.reddit.com/r/Korea/comments/abc12/some_title/', 'https://old.reddit.com/r/korea/comments/abc12/'],
];

const different: [string, string][] = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=aaaaaaaaaaa'],
  ['https://example.com/search?q=cats', 'https://example.com/search?q=dogs'],
  ['https://example.com/s?t=1', 'https://example.com/s?t=2'], // `t` is only tracking on x.com
  ['https://example.com/Path', 'https://example.com/path'],
];

test('equivalent links normalize to the same key', () => {
  for (const [a, b] of same) {
    const na = normalizeUrl(a);
    assert.ok(na, a);
    assert.equal(na, normalizeUrl(b), `${a}  vs  ${b}`);
    assert.equal(urlKey(na), urlKey(normalizeUrl(b)!));
  }
});

test('different links stay different', () => {
  for (const [a, b] of different) assert.notEqual(normalizeUrl(a), normalizeUrl(b), `${a}  vs  ${b}`);
});

test('normalized form', () => {
  assert.equal(normalizeUrl('https://youtu.be/dQw4w9WgXcQ?t=10'), 'youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(normalizeUrl('https://twitter.com/u/status/42'), 'x.com/i/status/42');
  assert.equal(normalizeUrl('https://example.com/'), 'example.com');
  assert.equal(normalizeUrl('https://example.com:8080/x'), 'example.com:8080/x');
  assert.equal(normalizeUrl('ftp://example.com/x'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('extractUrls trims punctuation and <no-embed> brackets', () => {
  assert.deepEqual(extractUrls('봐봐 https://a.com/x, 그리고 <https://b.com/y>.'), ['https://a.com/x', 'https://b.com/y']);
  assert.deepEqual(extractUrls('(https://en.wikipedia.org/wiki/Foo_(bar))'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(extractUrls('no links here'), []);
});
