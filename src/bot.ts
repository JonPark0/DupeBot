import {
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  type Message,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  MessageReferenceType,
  type PartialMessage,
} from 'discord.js';
import type { ResponseMode } from './modes.ts';
import { NOT_DUPLICATE } from './commands/definitions.ts';
import type { LinkItem, MessageLike } from './detect/collect.ts';
import { channelWatched, type Detector } from './dupe/detector.ts';
import { respondToDuplicate } from './dupe/respond.ts';
import { findSemanticMatch, type SemanticOptions } from './dupe/semantic.ts';
import { logger } from './logger.ts';
import type { SemanticJudge } from './semantic/judge.ts';
import { BoundedQueue } from './semantic/queue.ts';
import type { GuildSettings, MessageRef, Store } from './store/types.ts';

// Event and command handling. Kept apart from index.ts (startup) so the flow reads top to bottom.

interface SemanticJob {
  ref: MessageRef;
  link: LinkItem;
}

const RESPONDED_CACHE = 5000;
const STALE_RETRIES = 3;

export function toMessageLike(message: Message): MessageLike {
  return {
    content: message.content ?? '',
    attachments: [...message.attachments.values()].map((a) => ({ url: a.url, contentType: a.contentType, size: a.size })),
    embeds: message.embeds.map((e) => ({
      type: e.data.type ?? null,
      url: e.url,
      title: e.title,
      description: e.description,
      image: e.image ? { url: e.image.url, proxyURL: e.image.proxyURL ?? null } : null,
      thumbnail: e.thumbnail ? { url: e.thumbnail.url, proxyURL: e.thumbnail.proxyURL ?? null } : null,
    })),
  };
}

function refOf(message: Message<true>): MessageRef {
  return {
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author.id,
    postedAt: message.createdAt,
  };
}

export interface BotOptions {
  client: Client;
  store: Store;
  detector: Detector;
  judge: SemanticJudge;
  semantic: SemanticOptions;
  semanticMaxBacklog: number;
  startedAt: number;
}

export class Bot {
  client: Client;
  store: Store;
  detector: Detector;
  judge: SemanticJudge;
  semantic: SemanticOptions;
  queue: BoundedQueue<SemanticJob>;
  startedAt: number;
  responded = new Set<string>();
  backfilling = new Set<string>();

  constructor(options: BotOptions) {
    this.client = options.client;
    this.store = options.store;
    this.detector = options.detector;
    this.judge = options.judge;
    this.semantic = options.semantic;
    this.startedAt = options.startedAt;
    this.queue = new BoundedQueue((job) => this.runSemantic(job), options.semanticMaxBacklog);
  }

  markResponded(messageId: string): void {
    this.responded.add(messageId);
    if (this.responded.size > RESPONDED_CACHE) {
      const oldest = this.responded.values().next().value;
      if (oldest !== undefined) this.responded.delete(oldest);
    }
  }

  async watchedSettings(message: Message<true>): Promise<GuildSettings | null> {
    if (message.author.bot || message.system || message.webhookId) return null;
    // a forward is a deliberate quote of an earlier message, not a repost
    if (message.reference?.type === MessageReferenceType.Forward) return null;
    const settings = await this.store.getSettings(message.guildId);
    const parentId = message.channel.isThread() ? message.channel.parentId : null;
    return channelWatched(settings, message.channelId, parentId) ? settings : null;
  }

  /** messageCreate and messageUpdate (edits, and embeds Discord attaches a moment later). */
  async onMessage(message: Message | PartialMessage): Promise<void> {
    try {
      if (message.partial) message = await message.fetch();
      if (!message.inGuild()) return;
      const settings = await this.watchedSettings(message);
      if (!settings) return;

      const ref = refOf(message);
      const { fresh, semanticLinks } = await this.detector.index(ref, toMessageLike(message));
      if (this.responded.has(message.id)) return;
      if ((fresh.length || semanticLinks.length) && (await this.store.responsesFor(message.id)).length) {
        this.markResponded(message.id); // answered before a restart
        return;
      }

      if (fresh.length) {
        for (let attempt = 0; attempt < STALE_RETRIES; attempt++) {
          const match = await this.detector.findMatch(ref, fresh, settings);
          if (!match) break;
          const outcome = await respondToDuplicate(this.client, this.store, message, match.hit, 'exact', settings);
          if (outcome === 'stale') continue; // original was deleted; it's gone from the index now, try the next one
          this.markResponded(message.id);
          logger.info(`[dupe] ${message.id} repeats ${match.hit.messageId} (${match.reason})`);
          return;
        }
      }

      if (settings.semanticEnabled && semanticLinks.length && this.judge.isAvailable()) {
        for (const link of semanticLinks) {
          if (!this.queue.push({ ref, link })) logger.debug(`[semantic] backlog full, skipped ${message.id}`);
        }
      }
    } catch (err) {
      logger.error(`[dupe] failed to process message ${message.id}:`, err);
    }
  }

  async runSemantic(job: SemanticJob): Promise<void> {
    if (this.responded.has(job.ref.messageId)) return;
    const settings = await this.store.getSettings(job.ref.guildId);
    const match = await findSemanticMatch(this.store, this.judge, job.ref, job.link, settings, this.semantic);
    if (!match || this.responded.has(job.ref.messageId)) return;

    let message: Message;
    try {
      const channel = await this.client.channels.fetch(job.ref.channelId);
      if (!channel?.isTextBased()) return;
      message = await channel.messages.fetch(job.ref.messageId);
    } catch {
      return; // deleted meanwhile
    }
    if (!message.inGuild()) return;
    const outcome = await respondToDuplicate(this.client, this.store, message, match.candidate, 'semantic', settings);
    if (outcome === 'done') {
      this.markResponded(message.id);
      logger.info(
        `[semantic] ${message.id} looks like ${match.candidate.messageId} (confidence ${match.confidence.toFixed(2)})`,
      );
    }
  }

  async onMessageDelete(message: Message | PartialMessage): Promise<void> {
    try {
      await this.store.removeMessage(message.id);
    } catch (err) {
      logger.warn(`[dupe] could not remove deleted message ${message.id}: ${(err as Error).message}`);
    }
  }

  // ── commands ──

  async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) return;
    if (interaction.commandName === 'status') return this.status(interaction);
    if (interaction.commandName !== 'dupe') return;
    const sub = interaction.options.getSubcommand();
    if (sub === 'config') return this.config(interaction);
    if (sub === 'channel') return this.channel(interaction);
    if (sub === 'backfill') return this.backfill(interaction);
  }

  describeSettings(settings: GuildSettings): string {
    const channels = (ids: string[]) => (ids.length ? ids.map((id) => `<#${id}>`).join(' ') : '없음');
    return [
      `이모지: ${settings.emoji} (비슷한 내용: ${settings.semanticEmoji})`,
      `반응 방식: \`${settings.mode}\``,
      `사진 유사도 기준 (dHash): ${settings.hammingThreshold}`,
      `같은 작성자 재게시 무시: ${settings.sameAuthorMinutes ? `${settings.sameAuthorMinutes}분` : '사용 안 함'}`,
      `Claude 의미 기반 판정: ${settings.semanticEnabled ? '켜짐' : '꺼짐'}`,
      `감시 채널: ${settings.includeChannels.length ? channels(settings.includeChannels) : '전체'}`,
      `제외 채널: ${channels(settings.excludeChannels)}`,
    ].join('\n');
  }

  async config(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const patch: Partial<GuildSettings> = {};
    const emoji = interaction.options.getString('emoji');
    const semanticEmoji = interaction.options.getString('semantic_emoji');
    const mode = interaction.options.getString('mode');
    const threshold = interaction.options.getInteger('threshold');
    const sameAuthor = interaction.options.getInteger('same_author_minutes');
    const semantic = interaction.options.getBoolean('semantic');
    if (emoji) patch.emoji = emoji.trim();
    if (semanticEmoji) patch.semanticEmoji = semanticEmoji.trim();
    if (mode) patch.mode = mode as ResponseMode;
    if (threshold !== null) patch.hammingThreshold = threshold;
    if (sameAuthor !== null) patch.sameAuthorMinutes = sameAuthor;
    if (semantic !== null) patch.semanticEnabled = semantic;

    const settings = Object.keys(patch).length
      ? await this.store.updateSettings(interaction.guildId, patch)
      : await this.store.getSettings(interaction.guildId);
    await interaction.reply({ content: this.describeSettings(settings), flags: MessageFlags.Ephemeral });
  }

  async channel(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const action = interaction.options.getString('action', true);
    const channel = interaction.options.getChannel('channel');
    const current = await this.store.getSettings(interaction.guildId);
    let includeChannels = current.includeChannels.slice();
    let excludeChannels = current.excludeChannels.slice();

    if (action === 'clear') {
      includeChannels = [];
      excludeChannels = [];
    } else {
      if (!channel) {
        await interaction.reply({ content: '채널을 지정해 주세요.', flags: MessageFlags.Ephemeral });
        return;
      }
      includeChannels = includeChannels.filter((id) => id !== channel.id);
      excludeChannels = excludeChannels.filter((id) => id !== channel.id);
      if (action === 'include') includeChannels.push(channel.id);
      if (action === 'exclude') excludeChannels.push(channel.id);
    }
    const settings = await this.store.updateSettings(interaction.guildId, { includeChannels, excludeChannels });
    await interaction.reply({ content: this.describeSettings(settings), flags: MessageFlags.Ephemeral });
  }

  async backfill(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const channel = interaction.options.getChannel('channel', true);
    const limit = interaction.options.getInteger('limit') ?? 1000;
    if (!channel.isTextBased()) {
      await interaction.reply({ content: '메시지를 읽을 수 있는 채널이 아니에요.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (this.backfilling.has(interaction.guildId)) {
      await interaction.reply({ content: '이미 색인 중이에요. 끝난 뒤에 다시 실행해 주세요.', flags: MessageFlags.Ephemeral });
      return;
    }
    this.backfilling.add(interaction.guildId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let scanned = 0;
    let indexed = 0;
    let before: string | undefined;
    try {
      while (scanned < limit) {
        const batch = await channel.messages.fetch({ limit: Math.min(100, limit - scanned), before });
        if (batch.size === 0) break;
        for (const message of batch.values()) {
          scanned++;
          if (!message.inGuild() || message.author.bot || message.system) continue;
          if (message.reference?.type === MessageReferenceType.Forward) continue;
          const { fresh } = await this.detector.index(refOf(message), toMessageLike(message));
          if (fresh.length) indexed++;
        }
        before = batch.last()?.id;
        if (scanned % 500 < 100) await interaction.editReply(`<#${channel.id}> 색인 중… ${scanned}개 확인`);
      }
      await interaction.editReply(`<#${channel.id}> 색인 완료: 메시지 ${scanned}개 확인, ${indexed}개에서 링크·이미지 저장`);
    } catch (err) {
      logger.error('[backfill] failed:', err);
      await interaction.editReply(`색인 중 오류가 났어요 (${scanned}개까지 처리): ${(err as Error).message}`);
    } finally {
      this.backfilling.delete(interaction.guildId);
    }
  }

  async status(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dbOk = await this.store.ping();
    const llm = await this.judge.status();
    const counts = dbOk ? await this.store.countForGuild(interaction.guildId) : null;
    const llmText = {
      on: '켜짐',
      disabled: '꺼짐 (API 키 없음)',
      cooldown: `일시 중지 (<t:${Math.floor(llm.cooldownUntil / 1000)}:R>에 재시도)`,
      budget: '오늘 예산 소진 (00:00 UTC에 재개)',
      failed: '꺼짐 (모델 사용 불가)',
    }[llm.state];
    const embed = new EmbedBuilder()
      .setTitle('DupeBot 상태')
      .addFields(
        { name: 'DB', value: dbOk ? '정상' : '연결 안 됨', inline: true },
        { name: 'Claude', value: `${llmText}${llm.reason && llm.state !== 'on' ? `\n${llm.reason}` : ''}`, inline: true },
        { name: '오늘 Claude 사용량', value: `${llm.todayCalls}회 · $${llm.todayUsd.toFixed(4)}`, inline: true },
        {
          name: '색인',
          value: counts ? `링크 ${counts.urls}개 · 이미지 ${counts.images}개` : '-',
          inline: true,
        },
        { name: '의미 판정 대기열', value: `${this.queue.size}건 (버림 ${this.queue.dropped}건)`, inline: true },
        { name: '가동 시작', value: `<t:${Math.floor(this.startedAt / 1000)}:R>`, inline: true },
      );
    await interaction.editReply({ embeds: [embed] });
  }

  /** Context menu "중복 아님": undo the bot's answer and stop flagging this content. */
  async onNotDuplicate(interaction: MessageContextMenuCommandInteraction): Promise<void> {
    if (!interaction.inCachedGuild() || interaction.commandName !== NOT_DUPLICATE) return;
    const target = interaction.targetMessage;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const responses = await this.store.responsesFor(target.id);
    if (responses.length === 0) {
      await interaction.editReply('이 메시지에는 DupeBot이 반응하지 않았어요.');
      return;
    }

    for (const reaction of target.reactions.cache.values()) {
      if (reaction.me) await reaction.users.remove(this.client.user!.id).catch(() => undefined);
    }
    for (const response of responses) {
      if (!response.botMessageId) continue;
      try {
        const channel = await this.client.channels.fetch(response.channelId);
        if (channel?.isTextBased()) await (await channel.messages.fetch(response.botMessageId)).delete();
      } catch {
        // already gone
      }
    }

    // an exact match is about this content: don't flag it again. A Claude match was only a guess
    // about two different links, so nothing is allowlisted for it.
    let allowlisted = 0;
    if (responses.some((response) => response.kind === 'exact')) {
      const items = await this.store.fingerprintsFor(target.id);
      await this.store.addAllowlist(interaction.guildId, items, interaction.user.id);
      allowlisted = items.length;
    }
    await this.store.deleteResponses(target.id);
    await interaction.editReply(
      allowlisted ? `반응을 지우고 이 링크·이미지 ${allowlisted}개는 앞으로 중복으로 보지 않아요.` : '반응을 지웠어요.',
    );
  }
}
