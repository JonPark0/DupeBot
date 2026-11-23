import { createHash } from 'node:crypto';

// Video attachments are matched by their exact bytes. Hashed while streaming, so memory stays flat
// however large the file is; anything over the cap, or a failed download, is skipped (null).

export async function hashFileUrl(url: string, maxBytes: number, timeoutMs = 60_000): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !response.body) return null;
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) return null;
    const hash = createHash('sha256');
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) return null;
      hash.update(chunk);
    }
    return total > 0 ? hash.digest('hex') : null;
  } catch {
    return null;
  }
}
