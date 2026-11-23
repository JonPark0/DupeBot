import type { ResponseMode } from '../modes.ts';

// The storage interface the bot logic depends on. PgStore implements it on Postgres; tests use
// an in-memory fake, so the matching logic runs without a database.

export type FingerprintKind = 'url' | 'image' | 'file';

export interface Fingerprint {
  kind: FingerprintKind;
  /** sha256 hex: of the normalized URL, or of the image bytes */
  key: string;
  /** 64-bit dHash (unsigned) for images, null for links */
  dhash: bigint | null;
  /** embed title/description for links (semantic matching), null otherwise */
  title: string | null;
  description: string | null;
}

export interface MessageRef {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  postedAt: Date;
}

export interface IndexedHit extends MessageRef {
  kind: FingerprintKind;
  key: string;
}

export interface SemanticCandidate extends MessageRef {
  title: string | null;
  description: string | null;
  similarity: number;
}

export interface GuildSettings {
  emoji: string;
  semanticEmoji: string;
  mode: ResponseMode;
  hammingThreshold: number;
  /** a repost by the same author within this many minutes is ignored; 0 = always flag */
  sameAuthorMinutes: number;
  semanticEnabled: boolean;
  /** empty = every channel */
  includeChannels: string[];
  excludeChannels: string[];
  /** bot / webhook / application IDs whose posts count as the member they mention (see dupe/relay.ts) */
  relayBots: string[];
  /** server sticker sent in sticker mode */
  stickerId: string | null;
  /** also react with `emoji` in sticker mode */
  stickerReact: boolean;
}

export type ResponseKind = 'exact' | 'semantic';

export interface ResponseRecord {
  channelId: string;
  botMessageId: string | null;
  kind: ResponseKind;
}

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface UsageStore {
  getLlmUsage(day: string): Promise<LlmUsage>;
  addLlmUsage(day: string, inputTokens: number, outputTokens: number, usd: number): Promise<void>;
}

export interface Store extends UsageStore {
  ping(): Promise<boolean>;
  getSettings(guildId: string): Promise<GuildSettings>;
  updateSettings(guildId: string, patch: Partial<GuildSettings>): Promise<GuildSettings>;

  fingerprintsFor(messageId: string): Promise<Fingerprint[]>;
  upsertFingerprints(ref: MessageRef, items: Fingerprint[]): Promise<void>;
  removeMessage(messageId: string): Promise<void>;

  /** The oldest other message with this exact key, posted no later than `ref`. */
  findExact(ref: MessageRef, kind: FingerprintKind, key: string): Promise<IndexedHit | null>;
  /** The oldest other message with an image whose dHash is within `maxDistance` bits. */
  findSimilarImage(ref: MessageRef, dhash: bigint, maxDistance: number): Promise<IndexedHit | null>;
  semanticCandidates(
    ref: MessageRef,
    text: string,
    options: { sinceDays: number; limit: number; minSimilarity: number; excludeKeys: string[] },
  ): Promise<SemanticCandidate[]>;

  isAllowlisted(guildId: string, item: Fingerprint, maxDistance: number): Promise<boolean>;
  addAllowlist(guildId: string, items: Fingerprint[], userId: string): Promise<void>;

  recordResponse(messageId: string, record: ResponseRecord): Promise<void>;
  responsesFor(messageId: string): Promise<ResponseRecord[]>;
  deleteResponses(messageId: string): Promise<void>;

  countForGuild(guildId: string): Promise<{ urls: number; images: number; files: number }>;
  /** Delete entries older than `retentionDays`. Returns the number of fingerprints removed. */
  purge(retentionDays: number): Promise<number>;
}
