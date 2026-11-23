import {
  collectFileSources,
  collectImageSources,
  collectLinks,
  DEFAULT_IGNORED_HOSTS,
  type LinkItem,
  type MessageLike,
} from '../detect/collect.ts';
import type { ImageHash } from '../detect/image.ts';
import type { Fingerprint, GuildSettings, IndexedHit, MessageRef, Store } from '../store/types.ts';

// Fingerprints a message, stores it, and looks for an earlier post with the same link or image.

export interface ExactMatch {
  reason: 'url' | 'file' | 'image' | 'similar-image';
  hit: IndexedHit;
}

export interface IndexResult {
  /** fingerprints seen for the first time on this message (new post, or embeds that arrived later) */
  fresh: Fingerprint[];
  /** links whose preview text is known and new, what the semantic check looks at */
  semanticLinks: LinkItem[];
}

export interface DetectorDeps {
  store: Store;
  /** download + hash; null when the image is too small, too large or unreadable */
  hashImageUrl: (url: string) => Promise<ImageHash | null>;
  imageMaxBytes: number;
  /** download + sha256 of a video attachment; null on failure or over the cap */
  hashFileUrl?: (url: string) => Promise<string | null>;
  /** largest video attachment to hash (0 = videos off) */
  fileMaxBytes?: number;
  ignoredHosts?: readonly string[];
}

const IMAGE_CACHE_SIZE = 500;

/** Is this channel (or the thread's parent) watched under these settings? */
export function channelWatched(settings: GuildSettings, channelId: string, parentId: string | null): boolean {
  const ids = parentId ? [channelId, parentId] : [channelId];
  if (ids.some((id) => settings.excludeChannels.includes(id))) return false;
  if (settings.includeChannels.length === 0) return true;
  return ids.some((id) => settings.includeChannels.includes(id));
}

/** A repost by the same author shortly after their own post is usually a correction, not a duplicate. */
export function isOwnRecentRepost(ref: MessageRef, hit: MessageRef, sameAuthorMinutes: number): boolean {
  if (sameAuthorMinutes <= 0 || hit.authorId !== ref.authorId) return false;
  return ref.postedAt.getTime() - hit.postedAt.getTime() < sameAuthorMinutes * 60_000;
}

export class Detector {
  deps: DetectorDeps;
  // An edit or a late embed re-delivers the same attachment URLs; don't download them twice.
  imageCache = new Map<string, ImageHash | null>();
  fileCache = new Map<string, string>();

  constructor(deps: DetectorDeps) {
    this.deps = deps;
  }

  rememberFile(url: string, key: string): void {
    this.fileCache.set(url, key);
    if (this.fileCache.size > IMAGE_CACHE_SIZE) {
      const oldest = this.fileCache.keys().next().value;
      if (oldest !== undefined) this.fileCache.delete(oldest);
    }
  }

  async hashCached(url: string): Promise<ImageHash | null> {
    if (this.imageCache.has(url)) return this.imageCache.get(url) ?? null;
    const hash = await this.deps.hashImageUrl(url);
    this.imageCache.set(url, hash);
    if (this.imageCache.size > IMAGE_CACHE_SIZE) {
      const oldest = this.imageCache.keys().next().value;
      if (oldest !== undefined) this.imageCache.delete(oldest);
    }
    return hash;
  }

  /** Fingerprint and store a message. Safe to call again on edits: only new fingerprints are returned. */
  async index(ref: MessageRef, message: MessageLike): Promise<IndexResult> {
    const ignored = this.deps.ignoredHosts ?? DEFAULT_IGNORED_HOSTS;
    const existing = await this.deps.store.fingerprintsFor(ref.messageId);
    const known = new Map(existing.map((item) => [`${item.kind}:${item.key}`, item]));

    const links = collectLinks(message, ignored);
    const items = new Map<string, Fingerprint>();
    for (const link of links) {
      items.set(`url:${link.key}`, { kind: 'url', key: link.key, dhash: null, title: link.title, description: link.description });
    }
    for (const source of collectImageSources(message, this.deps.imageMaxBytes, ignored)) {
      const hash = await this.hashCached(source.url);
      if (!hash) continue;
      items.set(`image:${hash.sha256}`, { kind: 'image', key: hash.sha256, dhash: hash.dhash, title: null, description: null });
    }
    const { hashFileUrl, fileMaxBytes = 0 } = this.deps;
    if (hashFileUrl) {
      for (const source of collectFileSources(message, fileMaxBytes)) {
        // an attachment URL never changes, so an edit doesn't download the video again
        const key = this.fileCache.get(source.url) ?? (await hashFileUrl(source.url));
        if (!key) continue;
        this.rememberFile(source.url, key);
        items.set(`file:${key}`, { kind: 'file', key, dhash: null, title: null, description: null });
      }
    }

    const fresh: Fingerprint[] = [];
    const changed: Fingerprint[] = [];
    const semanticKeys = new Set<string>();
    for (const [id, item] of items) {
      const before = known.get(id);
      if (!before) {
        fresh.push(item);
        changed.push(item);
        if (item.kind === 'url' && item.title) semanticKeys.add(item.key);
      } else if (item.kind === 'url' && item.title && !before.title) {
        // the link preview arrived after the message (Discord adds embeds asynchronously)
        changed.push(item);
        semanticKeys.add(item.key);
      }
    }
    if (changed.length) await this.deps.store.upsertFingerprints(ref, changed);

    return { fresh, semanticLinks: links.filter((link) => semanticKeys.has(link.key)) };
  }

  /**
   * The earliest matching post for the given fingerprints, checked in order of certainty:
   * same link, same video file, same image file, same picture (dHash). Allowlisted fingerprints and the author's
   * own recent reposts are skipped.
   */
  async findMatch(ref: MessageRef, items: Fingerprint[], settings: GuildSettings): Promise<ExactMatch | null> {
    const { store } = this.deps;
    const usable: Fingerprint[] = [];
    for (const item of items) {
      if (!(await store.isAllowlisted(ref.guildId, item, settings.hammingThreshold))) usable.push(item);
    }
    const accept = (hit: IndexedHit | null) => (hit && !isOwnRecentRepost(ref, hit, settings.sameAuthorMinutes) ? hit : null);

    for (const item of usable.filter((i) => i.kind === 'url')) {
      const hit = accept(await store.findExact(ref, 'url', item.key));
      if (hit) return { reason: 'url', hit };
    }
    for (const item of usable.filter((i) => i.kind === 'file')) {
      const hit = accept(await store.findExact(ref, 'file', item.key));
      if (hit) return { reason: 'file', hit };
    }
    const images = usable.filter((i) => i.kind === 'image');
    for (const item of images) {
      const hit = accept(await store.findExact(ref, 'image', item.key));
      if (hit) return { reason: 'image', hit };
    }
    for (const item of images) {
      if (item.dhash === null) continue;
      const hit = accept(await store.findSimilarImage(ref, item.dhash, settings.hammingThreshold));
      if (hit) return { reason: 'similar-image', hit };
    }
    return null;
  }
}
