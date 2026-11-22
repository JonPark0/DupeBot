// In-memory Store for tests: same semantics as PgStore, minus SQL.
import { hamming } from '../src/detect/image.ts';
import type {
  Fingerprint,
  FingerprintKind,
  GuildSettings,
  IndexedHit,
  LlmUsage,
  MessageRef,
  ResponseRecord,
  SemanticCandidate,
  Store,
} from '../src/store/types.ts';

export const DEFAULT_SETTINGS: GuildSettings = {
  emoji: '🔁',
  semanticEmoji: '🤔',
  mode: 'forward',
  hammingThreshold: 6,
  sameAuthorMinutes: 10,
  semanticEnabled: true,
  includeChannels: [],
  excludeChannels: [],
  relayBots: [],
};

interface Row extends MessageRef, Fingerprint {}

export class MemoryStore implements Store {
  rows: Row[] = [];
  allow: { guildId: string; key: string; dhash: bigint | null }[] = [];
  responses = new Map<string, ResponseRecord[]>();
  usage = new Map<string, LlmUsage>();
  settings = new Map<string, GuildSettings>();
  /** what semanticCandidates returns (similarity is not computed here) */
  candidates: SemanticCandidate[] = [];

  async ping() {
    return true;
  }
  async getSettings(guildId: string) {
    return this.settings.get(guildId) ?? { ...DEFAULT_SETTINGS };
  }
  async updateSettings(guildId: string, patch: Partial<GuildSettings>) {
    const next = { ...(await this.getSettings(guildId)), ...patch };
    this.settings.set(guildId, next);
    return next;
  }
  async fingerprintsFor(messageId: string) {
    return this.rows
      .filter((r) => r.messageId === messageId)
      .map(({ kind, key, dhash, title, description }) => ({ kind, key, dhash, title, description }));
  }
  async upsertFingerprints(ref: MessageRef, items: Fingerprint[]) {
    for (const item of items) {
      const existing = this.rows.find((r) => r.messageId === ref.messageId && r.kind === item.kind && r.key === item.key);
      if (existing) {
        existing.title = item.title ?? existing.title;
        existing.description = item.description ?? existing.description;
      } else this.rows.push({ ...ref, ...item });
    }
  }
  async removeMessage(messageId: string) {
    this.rows = this.rows.filter((r) => r.messageId !== messageId);
  }
  oldest(rows: Row[]): IndexedHit | null {
    const row = rows.sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime())[0];
    return row ? { ...row } : null;
  }
  async findExact(ref: MessageRef, kind: FingerprintKind, key: string) {
    return this.oldest(
      this.rows.filter(
        (r) => r.guildId === ref.guildId && r.kind === kind && r.key === key && r.messageId !== ref.messageId && r.postedAt <= ref.postedAt,
      ),
    );
  }
  async findSimilarImage(ref: MessageRef, dhash: bigint, maxDistance: number) {
    return this.oldest(
      this.rows.filter(
        (r) =>
          r.guildId === ref.guildId &&
          r.kind === 'image' &&
          r.dhash !== null &&
          r.messageId !== ref.messageId &&
          r.postedAt <= ref.postedAt &&
          hamming(r.dhash, dhash) <= maxDistance,
      ),
    );
  }
  async semanticCandidates() {
    return this.candidates;
  }
  async isAllowlisted(guildId: string, item: Fingerprint, maxDistance: number) {
    return this.allow.some(
      (a) =>
        a.guildId === guildId &&
        (a.key === item.key || (a.dhash !== null && item.dhash !== null && hamming(a.dhash, item.dhash) <= maxDistance)),
    );
  }
  async addAllowlist(guildId: string, items: Fingerprint[]) {
    for (const item of items) this.allow.push({ guildId, key: item.key, dhash: item.dhash });
  }
  async recordResponse(messageId: string, record: ResponseRecord) {
    this.responses.set(messageId, [...(this.responses.get(messageId) ?? []), record]);
  }
  async responsesFor(messageId: string) {
    return this.responses.get(messageId) ?? [];
  }
  async deleteResponses(messageId: string) {
    this.responses.delete(messageId);
  }
  async getLlmUsage(day: string) {
    return this.usage.get(day) ?? { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
  }
  async addLlmUsage(day: string, inputTokens: number, outputTokens: number, usd: number) {
    const u = await this.getLlmUsage(day);
    this.usage.set(day, {
      calls: u.calls + 1,
      inputTokens: u.inputTokens + inputTokens,
      outputTokens: u.outputTokens + outputTokens,
      usd: u.usd + usd,
    });
  }
  async countForGuild(guildId: string) {
    const rows = this.rows.filter((r) => r.guildId === guildId);
    return { urls: rows.filter((r) => r.kind === 'url').length, images: rows.filter((r) => r.kind === 'image').length };
  }
  async purge() {
    return 0;
  }
}
