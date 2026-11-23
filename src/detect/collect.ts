import { extractUrls, normalizeUrl, urlKey } from './url.ts';

// Pull the things worth fingerprinting out of a message. Works on a plain shape instead of
// discord.js classes so it can be tested without a Discord connection.

export interface AttachmentLike {
  url: string;
  contentType: string | null;
  size: number;
}

export interface EmbedLike {
  type?: string | null;
  url?: string | null;
  title?: string | null;
  description?: string | null;
  image?: { url: string; proxyURL?: string | null } | null;
  thumbnail?: { url: string; proxyURL?: string | null } | null;
}

export interface MessageLike {
  content: string;
  attachments: AttachmentLike[];
  embeds: EmbedLike[];
}

export interface LinkItem {
  key: string;
  normalized: string;
  title: string | null;
  description: string | null;
}

export interface FileSource {
  url: string;
  size: number;
}

/** Video attachments up to `maxBytes` (0 = none). Matched by exact bytes, not by picture. */
export function collectFileSources(message: MessageLike, maxBytes: number): FileSource[] {
  if (maxBytes <= 0) return [];
  return message.attachments
    .filter((a) => a.contentType?.startsWith('video/') && a.size > 0 && a.size <= maxBytes)
    .map((a) => ({ url: a.url, size: a.size }));
}

export interface ImageSource {
  url: string;
  origin: 'attachment' | 'embed';
}

// Reaction GIFs (Discord's GIF picker posts tenor links) and Discord's own links are reposted all
// the time on purpose; flagging them would be noise.
export const DEFAULT_IGNORED_HOSTS = [
  'tenor.com',
  'giphy.com',
  'media.giphy.com',
  'discord.com',
  'discordapp.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'discord.gg',
];

function hostOf(normalized: string): string {
  return normalized.split(/[/?:]/)[0];
}

function isIgnored(normalized: string, ignoredHosts: readonly string[]): boolean {
  const host = hostOf(normalized);
  return ignoredHosts.some((ignored) => host === ignored || host.endsWith(`.${ignored}`));
}

function clip(text: string | null | undefined, max: number): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Links in the message text and its embeds, normalized and de-duplicated. */
export function collectLinks(message: MessageLike, ignoredHosts: readonly string[] = DEFAULT_IGNORED_HOSTS): LinkItem[] {
  const embedText = new Map<string, { title: string | null; description: string | null }>();
  for (const embed of message.embeds) {
    const normalized = embed.url ? normalizeUrl(embed.url) : null;
    if (!normalized || embedText.has(normalized)) continue;
    embedText.set(normalized, { title: clip(embed.title, 300), description: clip(embed.description, 600) });
  }

  const urls = [...extractUrls(message.content), ...message.embeds.map((embed) => embed.url ?? '')];
  const items = new Map<string, LinkItem>();
  for (const raw of urls) {
    const normalized = raw ? normalizeUrl(raw) : null;
    if (!normalized || isIgnored(normalized, ignoredHosts) || items.has(normalized)) continue;
    const text = embedText.get(normalized);
    items.set(normalized, {
      key: urlKey(normalized),
      normalized,
      title: text?.title ?? null,
      description: text?.description ?? null,
    });
  }
  return [...items.values()];
}

/**
 * Images to fingerprint: image attachments, and pictures inside embeds that *are* the content
 * (a direct image link, a GIF, a post's photo). Article preview thumbnails are skipped: sites
 * reuse one logo image for many articles, which would flag unrelated links as duplicates.
 */
export function collectImageSources(
  message: MessageLike,
  maxBytes: number,
  ignoredHosts: readonly string[] = DEFAULT_IGNORED_HOSTS,
): ImageSource[] {
  const sources: ImageSource[] = [];
  const seen = new Set<string>();
  const add = (url: string | null | undefined, origin: ImageSource['origin']) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({ url, origin });
  };

  for (const attachment of message.attachments) {
    if (!attachment.contentType?.startsWith('image/')) continue;
    if (attachment.size > maxBytes) continue;
    add(attachment.url, 'attachment');
  }

  for (const embed of message.embeds) {
    const normalized = embed.url ? normalizeUrl(embed.url) : null;
    if (normalized && isIgnored(normalized, ignoredHosts)) continue;
    const type = embed.type ?? 'rich';
    if (type === 'image' || type === 'gifv') {
      // Discord puts the picture of a direct image link in the thumbnail field
      add(embed.thumbnail?.proxyURL ?? embed.thumbnail?.url ?? embed.image?.proxyURL ?? embed.image?.url, 'embed');
    } else if (type === 'rich') {
      add(embed.image?.proxyURL ?? embed.image?.url, 'embed');
    }
  }
  return sources;
}
