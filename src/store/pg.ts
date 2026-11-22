import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { fromSigned64, toSigned64 } from '../detect/image.ts';
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
} from './types.ts';

// BIGINT (int8) as JS bigint instead of string
pg.types.setTypeParser(20, (value) => BigInt(value));

const SCHEMA_URL = new URL('../../database/init.sql', import.meta.url);

interface HitRow {
  guild_id: string;
  channel_id: string;
  message_id: string;
  author_id: string;
  posted_at: Date;
  kind: FingerprintKind;
  key: string;
}

function toHit(row: HitRow): IndexedHit {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    authorId: row.author_id,
    postedAt: row.posted_at,
    kind: row.kind,
    key: row.key,
  };
}

const HIT_COLUMNS = 'guild_id, channel_id, message_id, author_id, posted_at, kind, key';

export class PgStore implements Store {
  pool: pg.Pool;
  defaults: GuildSettings;
  settingsCache = new Map<string, GuildSettings>();

  constructor(connectionString: string, defaults: GuildSettings) {
    this.pool = new pg.Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000 });
    this.defaults = defaults;
  }

  /** Apply database/init.sql (idempotent). */
  async migrate(): Promise<void> {
    const sql = await readFile(SCHEMA_URL, 'utf8');
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async getSettings(guildId: string): Promise<GuildSettings> {
    const cached = this.settingsCache.get(guildId);
    if (cached) return cached;
    const { rows } = await this.pool.query('SELECT * FROM guild_settings WHERE guild_id = $1', [guildId]);
    const row = rows[0];
    const settings: GuildSettings = row
      ? {
          emoji: row.emoji ?? this.defaults.emoji,
          semanticEmoji: row.semantic_emoji ?? this.defaults.semanticEmoji,
          mode: row.mode ?? this.defaults.mode,
          hammingThreshold: row.hamming_threshold ?? this.defaults.hammingThreshold,
          sameAuthorMinutes: row.same_author_minutes ?? this.defaults.sameAuthorMinutes,
          semanticEnabled: row.semantic_enabled,
          includeChannels: row.include_channels,
          excludeChannels: row.exclude_channels,
          relayBots: row.relay_bots ?? [],
        }
      : { ...this.defaults };
    this.settingsCache.set(guildId, settings);
    return settings;
  }

  async updateSettings(guildId: string, patch: Partial<GuildSettings>): Promise<GuildSettings> {
    const next = { ...(await this.getSettings(guildId)), ...patch };
    await this.pool.query(
      `INSERT INTO guild_settings (guild_id, emoji, semantic_emoji, mode, hamming_threshold, same_author_minutes,
                                   semantic_enabled, include_channels, exclude_channels, relay_bots, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (guild_id) DO UPDATE SET
         emoji = EXCLUDED.emoji, semantic_emoji = EXCLUDED.semantic_emoji, mode = EXCLUDED.mode,
         hamming_threshold = EXCLUDED.hamming_threshold, same_author_minutes = EXCLUDED.same_author_minutes,
         semantic_enabled = EXCLUDED.semantic_enabled, include_channels = EXCLUDED.include_channels,
         exclude_channels = EXCLUDED.exclude_channels, relay_bots = EXCLUDED.relay_bots, updated_at = now()`,
      [
        guildId,
        next.emoji,
        next.semanticEmoji,
        next.mode,
        next.hammingThreshold,
        next.sameAuthorMinutes,
        next.semanticEnabled,
        next.includeChannels,
        next.excludeChannels,
        next.relayBots,
      ],
    );
    this.settingsCache.set(guildId, next);
    return next;
  }

  async fingerprintsFor(messageId: string): Promise<Fingerprint[]> {
    const { rows } = await this.pool.query(
      'SELECT kind, key, dhash, title, description FROM fingerprints WHERE message_id = $1',
      [messageId],
    );
    return rows.map((row) => ({
      kind: row.kind,
      key: row.key,
      dhash: row.dhash === null ? null : fromSigned64(row.dhash),
      title: row.title,
      description: row.description,
    }));
  }

  async upsertFingerprints(ref: MessageRef, items: Fingerprint[]): Promise<void> {
    for (const item of items) {
      await this.pool.query(
        `INSERT INTO fingerprints (guild_id, channel_id, message_id, author_id, kind, key, dhash, title, description, posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (message_id, kind, key) DO UPDATE SET
           title = COALESCE(EXCLUDED.title, fingerprints.title),
           description = COALESCE(EXCLUDED.description, fingerprints.description)`,
        [
          ref.guildId,
          ref.channelId,
          ref.messageId,
          ref.authorId,
          item.kind,
          item.key,
          item.dhash === null ? null : toSigned64(item.dhash).toString(),
          item.title,
          item.description,
          ref.postedAt,
        ],
      );
    }
  }

  async removeMessage(messageId: string): Promise<void> {
    await this.pool.query('DELETE FROM fingerprints WHERE message_id = $1', [messageId]);
    await this.pool.query('DELETE FROM responses WHERE message_id = $1', [messageId]);
  }

  async findExact(ref: MessageRef, kind: FingerprintKind, key: string): Promise<IndexedHit | null> {
    const { rows } = await this.pool.query(
      `SELECT ${HIT_COLUMNS} FROM fingerprints
       WHERE guild_id = $1 AND kind = $2 AND key = $3 AND message_id <> $4 AND posted_at <= $5
       ORDER BY posted_at ASC LIMIT 1`,
      [ref.guildId, kind, key, ref.messageId, ref.postedAt],
    );
    return rows[0] ? toHit(rows[0]) : null;
  }

  async findSimilarImage(ref: MessageRef, dhash: bigint, maxDistance: number): Promise<IndexedHit | null> {
    const { rows } = await this.pool.query(
      `SELECT ${HIT_COLUMNS} FROM fingerprints
       WHERE guild_id = $1 AND kind = 'image' AND dhash IS NOT NULL AND message_id <> $2 AND posted_at <= $3
         AND bit_count((dhash # $4::bigint)::bit(64)) <= $5
       ORDER BY posted_at ASC LIMIT 1`,
      [ref.guildId, ref.messageId, ref.postedAt, toSigned64(dhash).toString(), maxDistance],
    );
    return rows[0] ? toHit(rows[0]) : null;
  }

  async semanticCandidates(
    ref: MessageRef,
    text: string,
    options: { sinceDays: number; limit: number; minSimilarity: number; excludeKeys: string[] },
  ): Promise<SemanticCandidate[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (message_id) guild_id, channel_id, message_id, author_id, posted_at, title, description,
                similarity(coalesce(title, '') || ' ' || coalesce(description, ''), $3) AS sim
         FROM fingerprints
         WHERE guild_id = $1 AND kind = 'url' AND title IS NOT NULL AND message_id <> $2
           AND posted_at <= $4 AND posted_at > $4 - make_interval(days => $5)
           AND NOT (key = ANY($6))
         ORDER BY message_id, sim DESC
       ) ranked
       WHERE sim >= $7
       ORDER BY sim DESC LIMIT $8`,
      [ref.guildId, ref.messageId, text, ref.postedAt, options.sinceDays, options.excludeKeys, options.minSimilarity, options.limit],
    );
    return rows.map((row) => ({
      guildId: row.guild_id,
      channelId: row.channel_id,
      messageId: row.message_id,
      authorId: row.author_id,
      postedAt: row.posted_at,
      title: row.title,
      description: row.description,
      similarity: Number(row.sim),
    }));
  }

  async isAllowlisted(guildId: string, item: Fingerprint, maxDistance: number): Promise<boolean> {
    const { rows } =
      item.dhash === null
        ? await this.pool.query('SELECT 1 FROM allowlist WHERE guild_id = $1 AND key = $2 LIMIT 1', [guildId, item.key])
        : await this.pool.query(
            `SELECT 1 FROM allowlist WHERE guild_id = $1
               AND (key = $2 OR (dhash IS NOT NULL AND bit_count((dhash # $3::bigint)::bit(64)) <= $4)) LIMIT 1`,
            [guildId, item.key, toSigned64(item.dhash).toString(), maxDistance],
          );
    return rows.length > 0;
  }

  async addAllowlist(guildId: string, items: Fingerprint[], userId: string): Promise<void> {
    for (const item of items) {
      await this.pool.query(
        `INSERT INTO allowlist (guild_id, key, dhash, added_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, key) DO NOTHING`,
        [guildId, item.key, item.dhash === null ? null : toSigned64(item.dhash).toString(), userId],
      );
    }
  }

  async recordResponse(messageId: string, record: ResponseRecord): Promise<void> {
    await this.pool.query(
      'INSERT INTO responses (message_id, channel_id, bot_message_id, kind) VALUES ($1, $2, $3, $4)',
      [messageId, record.channelId, record.botMessageId, record.kind],
    );
  }

  async responsesFor(messageId: string): Promise<ResponseRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT channel_id, bot_message_id, kind FROM responses WHERE message_id = $1',
      [messageId],
    );
    return rows.map((row) => ({ channelId: row.channel_id, botMessageId: row.bot_message_id, kind: row.kind }));
  }

  async deleteResponses(messageId: string): Promise<void> {
    await this.pool.query('DELETE FROM responses WHERE message_id = $1', [messageId]);
  }

  async getLlmUsage(day: string): Promise<LlmUsage> {
    const { rows } = await this.pool.query(
      'SELECT calls, input_tokens, output_tokens, usd FROM llm_usage WHERE day = $1',
      [day],
    );
    const row = rows[0];
    return row
      ? { calls: row.calls, inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), usd: Number(row.usd) }
      : { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
  }

  async addLlmUsage(day: string, inputTokens: number, outputTokens: number, usd: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_usage (day, calls, input_tokens, output_tokens, usd) VALUES ($1, 1, $2, $3, $4)
       ON CONFLICT (day) DO UPDATE SET calls = llm_usage.calls + 1,
         input_tokens = llm_usage.input_tokens + EXCLUDED.input_tokens,
         output_tokens = llm_usage.output_tokens + EXCLUDED.output_tokens,
         usd = llm_usage.usd + EXCLUDED.usd`,
      [day, inputTokens, outputTokens, usd],
    );
  }

  async countForGuild(guildId: string): Promise<{ urls: number; images: number }> {
    const { rows } = await this.pool.query(
      `SELECT count(*) FILTER (WHERE kind = 'url') AS urls, count(*) FILTER (WHERE kind = 'image') AS images
       FROM fingerprints WHERE guild_id = $1`,
      [guildId],
    );
    return { urls: Number(rows[0]?.urls ?? 0), images: Number(rows[0]?.images ?? 0) };
  }

  async purge(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const result = await this.pool.query(
      'DELETE FROM fingerprints WHERE posted_at < now() - make_interval(days => $1)',
      [retentionDays],
    );
    await this.pool.query('DELETE FROM responses WHERE created_at < now() - make_interval(days => $1)', [retentionDays]);
    await this.pool.query("DELETE FROM llm_usage WHERE day < current_date - 400");
    return result.rowCount ?? 0;
  }
}
