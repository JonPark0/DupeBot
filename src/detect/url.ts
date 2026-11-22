import { createHash } from 'node:crypto';

// URL extraction and normalization. Two links that open the same thing should normalize to the
// same string, so a repost through a share button (tracking params), a mobile host or an
// embed-fixer domain (fxtwitter, vxtwitter …) still matches the first post.

const URL_PATTERN = /https?:\/\/[^\s<>"'`|]+/gi;

// Query parameters that only track where a click came from. Exact names, plus the prefixes below.
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid',
  'igsh', 'igshid', 'mc_cid', 'mc_eid', 'mkt_tok', 'ref_src', 'ref_url', 'si', 'feature', 'pp',
  'spm', 'share_source', 'share_medium', 'share_id', 'from', 'from_source', 'vd_source',
  '_hsenc', '_hsmi', 'oly_anon_id', 'oly_enc_id', 'rb_clickid', 's_cid', 'ved', 'ei',
]);
const TRACKING_PREFIXES = ['utm_', 'pk_', 'mtm_', 'hsa_'];

// Parameters that are tracking on these hosts only (elsewhere `s` or `t` can mean something).
const HOST_TRACKING_PARAMS: Record<string, string[]> = {
  'x.com': ['s', 't'],
  'youtube.com': ['ab_channel'],
  'instagram.com': ['img_index'],
  'open.spotify.com': ['context', 'nd'],
};

// Embed fixers and aliases that show the same post as the canonical host.
const HOST_ALIASES: Record<string, string> = {
  'twitter.com': 'x.com',
  'mobile.twitter.com': 'x.com',
  'fxtwitter.com': 'x.com',
  'vxtwitter.com': 'x.com',
  'fixupx.com': 'x.com',
  'fixvx.com': 'x.com',
  'twittpr.com': 'x.com',
  'nitter.net': 'x.com',
  'music.youtube.com': 'youtube.com',
  'youtube-nocookie.com': 'youtube.com',
  'ddinstagram.com': 'instagram.com',
  'kkinstagram.com': 'instagram.com',
  'vxreddit.com': 'reddit.com',
  'old.reddit.com': 'reddit.com',
  'new.reddit.com': 'reddit.com',
  'vxtiktok.com': 'tiktok.com',
  'tnktok.com': 'tiktok.com',
};

/** Find http(s) links in message text. Strips trailing punctuation and Discord's <…> no-embed wrapper. */
export function extractUrls(text: string): string[] {
  const found = text.match(URL_PATTERN) ?? [];
  return found.map((raw) => {
    let url = raw.replace(/[>)\].,!?;:'"]+$/, '');
    // keep a closing paren that belongs to the URL, e.g. wikipedia.org/wiki/Foo_(bar)
    if (raw.length > url.length && (url.match(/\(/g)?.length ?? 0) > (url.match(/\)/g)?.length ?? 0)) {
      url += ')';
    }
    return url;
  });
}

function canonicalHost(hostname: string): string {
  let host = hostname.toLowerCase().replace(/\.$/, '');
  host = host.replace(/^(www\d?|m|mobile)\./, '');
  return HOST_ALIASES[host] ?? host;
}

function isTracking(host: string, name: string): boolean {
  const key = name.toLowerCase();
  if (TRACKING_PARAMS.has(key)) return true;
  if (TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  return HOST_TRACKING_PARAMS[host]?.includes(key) ?? false;
}

/**
 * Normalize a URL for comparison. Returns null for anything that is not a valid http(s) URL.
 * The result keeps the scheme-less form `host/path?query` (http and https are treated alike).
 */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  let host = canonicalHost(url.hostname);
  let path = url.pathname;
  const params = new URLSearchParams(url.search);

  // YouTube: youtu.be/<id>, /shorts/<id>, /live/<id>, /embed/<id> → youtube.com/watch?v=<id>
  if (host === 'youtu.be') {
    const id = path.split('/')[1];
    if (id) {
      host = 'youtube.com';
      path = '/watch';
      params.set('v', id);
    }
  } else if (host === 'youtube.com') {
    const match = path.match(/^\/(shorts|live|embed|v)\/([\w-]{6,})/);
    if (match) {
      path = '/watch';
      params.set('v', match[2]);
    }
  }
  if (host === 'youtube.com' && path === '/watch') {
    // a timestamp or playlist position still points at the same video
    for (const name of ['t', 'start', 'index', 'list']) params.delete(name);
  }

  // X: /<user>/status/<id>[/photo/1] → the id identifies the post, the user name can change
  if (host === 'x.com') {
    const match = path.match(/^\/(?:[^/]+|i\/web)\/status(?:es)?\/(\d+)/);
    if (match) path = `/i/status/${match[1]}`;
  }

  // Reddit share links carry the post id after /comments/<id>; drop the slug
  if (host === 'reddit.com') {
    const match = path.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
    if (match) path = `/r/${match[1].toLowerCase()}/comments/${match[2].toLowerCase()}`;
  }

  const kept = [...params.entries()]
    .filter(([name]) => !isTracking(host, name))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';

  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/') path = '';

  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
  return `${host}${port}${path}${query}`;
}

/** sha256 (hex) of the normalized URL — the key stored in the index. */
export function urlKey(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}
