import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Image fingerprints. Two per image:
//  - sha256 of the file bytes: the very same file (a re-upload of the same download)
//  - 64-bit dHash of the picture: the same picture after re-compression, resizing or a format change
// Images are hashed as soon as they are posted: Discord's attachment URLs are signed and expire,
// so nothing is fetched later. Only the hashes are stored.

sharp.cache(false); // nothing is decoded twice; keep libvips from holding memory between images
sharp.concurrency(1); // one image at a time on a small home server

export interface ImageHash {
  sha256: string;
  /** 64-bit difference hash, unsigned */
  dhash: bigint;
  width: number;
  height: number;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Hash an image buffer. Returns null when the image is smaller than `minSize` on either side
 * (emoji, icons, tracking pixels) or can't be decoded. Animated images use the first frame.
 */
export async function hashImage(bytes: Uint8Array, minSize = 64): Promise<ImageHash | null> {
  try {
    const image = sharp(bytes, { animated: false, limitInputPixels: 50_000_000, failOn: 'none' });
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    // for animated input, metadata height is that of all frames stacked; pageHeight is one frame
    const height = meta.pageHeight ?? meta.height ?? 0;
    if (width < minSize || height < minSize) return null;

    // dHash: shrink to 9x8 grey, then one bit per pixel: is it brighter than its right neighbour?
    const pixels = await image.flatten({ background: '#ffffff' }).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
    return { sha256: sha256Hex(bytes), dhash: dhashFromGrey9x8(pixels), width, height };
  } catch {
    return null;
  }
}

/** Build the 64-bit dHash from 72 greyscale bytes (9 columns x 8 rows). */
export function dhashFromGrey9x8(pixels: Uint8Array): bigint {
  if (pixels.length < 72) throw new Error(`dHash needs 72 pixels, got ${pixels.length}`);
  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = pixels[row * 9 + col];
      const right = pixels[row * 9 + col + 1];
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}

/** Number of differing bits between two 64-bit hashes. */
export function hamming(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/** Postgres stores the hash in a signed BIGINT column. */
export function toSigned64(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

export function fromSigned64(value: bigint | string): bigint {
  return BigInt.asUintN(64, BigInt(value));
}

/** Download an image with a size cap and timeout. Returns null on any failure. */
export async function downloadImage(url: string, maxBytes: number, timeoutMs = 15000): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !response.body) return null;
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}
