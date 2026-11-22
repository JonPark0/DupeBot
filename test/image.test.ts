import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { dhashFromGrey9x8, fromSigned64, hamming, hashImage, toSigned64 } from '../src/detect/image.ts';

/** A 256x192 test picture: diagonal gradient plus a dark block whose position varies. */
async function picture(blockX: number, format: 'png' | 'jpeg' = 'png', width = 256): Promise<Buffer> {
  const w = 256;
  const h = 192;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBlock = x >= blockX && x < blockX + 60 && y >= 40 && y < 120;
      const v = inBlock ? 20 : Math.round(((x + y) / (w + h)) * 255);
      raw.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
  }
  const img = sharp(raw, { raw: { width: w, height: h, channels: 3 } }).resize(width);
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 60 }).toBuffer();
}

test('hamming counts differing bits', () => {
  assert.equal(hamming(0n, 0n), 0);
  assert.equal(hamming(0n, 0xffffffffffffffffn), 64);
  assert.equal(hamming(0b1011n, 0b0001n), 2);
  assert.equal(hamming(-1n, 0n), 64); // signed values from Postgres
});

test('signed/unsigned round trip for BIGINT storage', () => {
  for (const v of [0n, 1n, 0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn]) {
    assert.equal(fromSigned64(toSigned64(v)), v);
  }
});

test('dHash bit layout', () => {
  const rising = Uint8Array.from({ length: 72 }, (_, i) => i % 9); // always darker on the left
  assert.equal(dhashFromGrey9x8(rising), 0n);
  const falling = Uint8Array.from({ length: 72 }, (_, i) => 9 - (i % 9));
  assert.equal(dhashFromGrey9x8(falling), 0xffffffffffffffffn);
});

test('a re-compressed, resized copy is within the threshold; a different picture is not', async () => {
  const original = await hashImage(await picture(30));
  const copy = await hashImage(await picture(30, 'jpeg', 180));
  const other = await hashImage(await picture(170));
  assert.ok(original && copy && other);
  assert.notEqual(original.sha256, copy.sha256);
  assert.ok(hamming(original.dhash, copy.dhash) <= 6, `copy distance ${hamming(original.dhash, copy.dhash)}`);
  assert.ok(hamming(original.dhash, other.dhash) > 6, `other distance ${hamming(original.dhash, other.dhash)}`);
});

test('tiny and unreadable images are skipped', async () => {
  const tiny = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#888' } }).png().toBuffer();
  assert.equal(await hashImage(tiny, 64), null);
  assert.equal(await hashImage(Buffer.from('not an image'), 64), null);
});
