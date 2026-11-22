import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectImageSources, collectLinks } from '../src/detect/collect.ts';

test('links from text and embeds are merged, with the preview text attached', () => {
  const links = collectLinks({
    content: 'https://www.example.com/a?utm_source=x 그리고 https://tenor.com/view/cat-123',
    attachments: [],
    embeds: [{ type: 'article', url: 'https://example.com/a', title: '제목', description: '설명' }],
  });
  assert.equal(links.length, 1, 'tenor reaction GIFs are ignored');
  assert.equal(links[0].normalized, 'example.com/a');
  assert.equal(links[0].title, '제목');
});

test('images: attachments and content images, but not article thumbnails or tenor GIFs', () => {
  const sources = collectImageSources(
    {
      content: '',
      attachments: [
        { url: 'https://cdn/a.png', contentType: 'image/png', size: 100 },
        { url: 'https://cdn/b.mp4', contentType: 'video/mp4', size: 100 },
        { url: 'https://cdn/big.png', contentType: 'image/png', size: 10_000 },
      ],
      embeds: [
        { type: 'image', url: 'https://i.example/x.jpg', thumbnail: { url: 'https://i.example/x.jpg', proxyURL: 'https://proxy/x.jpg' } },
        { type: 'rich', url: 'https://x.com/u/status/1', image: { url: 'https://pbs/1.jpg' } },
        { type: 'article', url: 'https://news.example/a', thumbnail: { url: 'https://news.example/logo.png' } },
        { type: 'gifv', url: 'https://tenor.com/view/x', thumbnail: { url: 'https://media.tenor.com/x.png' } },
      ],
    },
    1000,
  );
  assert.deepEqual(
    sources.map((s) => s.url),
    ['https://cdn/a.png', 'https://proxy/x.jpg', 'https://pbs/1.jpg'],
  );
});
