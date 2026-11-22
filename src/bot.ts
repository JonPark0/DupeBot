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
import { classifySource, type Source } from './dupe/relay.ts';
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

function refOf(message: Message<true>, authorId: string): MessageRef {
  return {
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    authorId,
    postedAt: message.createdAt,
  };
}

function sourceOf(message: Message<true>, relayBots: readonly string[]): Source {
  if (message.system) return { kind: 'ignored' };
  // a forward is a deliberate quote of an earlier message, not a repost
  if (message.reference?.type === MessageReferenceType.Forward) return { kind: 'ignored' };
  return classifySource(
    {
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      webhookId: message.webhookId,
      applicationId: message.applicationId,
      mentionedUserIds: [...message.mentions.users.values()].filter((u) => !u.bot).map((u) => u.id),
    },
    relayBots,
    message.client.user?.id ?? null,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface BotOptions {
  client: Client;
  store: Store;
  detector: Detector;
  judge: SemanticJudge;
  semantic: SemanticOptions;
  semanticMaxBacklog: number;
  startedAt: number;
  retentionDays: number;
  relayGraceMs: number;
}

interface BackfillProgress {
  channelId: string;
  scanned: number;
  indexed: number;
  oldest: Date | null;
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
  retentionDays: number;
  relayGraceMs: number;
  responded = new Set<string>();
  /** running backfills by guild, shown in /status */
  backfilling = new Map<string, BackfillProgress>();

  constructor(options: BotOptions) {
    this.client = options.client;
    this.store = options.store;
    this.detector = options.detector;
    this.judge = options.judge;
    this.semantic = options.semantic;
    this.startedAt = options.startedAt;
    this.retentionDays = options.retentionDays;
    this.relayGraceMs = options.relayGraceMs;
    this.queue = new BoundedQueue((job) => this.runSemantic(job), options.semanticMaxBacklog);
  }

  markResponded(messageId: string): void {
    this.responded.add(messageId);
    if (this.responded.size > RESPONDED_CACHE) {
      const oldest = this.responded.values().next().value;
      if (oldest !== undefined) this.responded.delete(oldest);
    }
  }

  async watched(message: Message<true>): Promise<{ settings: GuildSettings; source: Exclude<Source, { kind: 'ignored' }> } | null> {
    if (message.system) return null;
    const settings = await this.store.getSettings(message.guildId);
    const source = sourceOf(message, settings.relayBots);
    if (source.kind === 'ignored') return null;
    const parentId = message.channel.isThread() ? message.channel.parentId : null;
    return channelWatched(settings, message.channelId, parentId) ? { settings, source } : null;
  }

  /** The member whose channel access decides what may be shared in an answer. */
  viewerOf(message: Message<true>, source: Exclude<Source, { kind: 'ignored' }>) {
    if (source.kind === 'member') return message.member ?? message.author.id;
    return message.mentions.members?.get(source.authorId) ?? source.authorId;
  }

  /** False when the message was deleted (or can't be read any more). */
  async stillExists(message: Message<true>): Promise<boolean> {
    try {
      await message.channel.messages.fetch({ message: message.id, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** messageCreate and messageUpdate (edits, and embeds Discord attaches a moment later). */
  async onMessage(message: Message | PartialMessage): Promise<void> {
    try {
      if (message.partial) message = await message.fetch();
      if (!message.inGuild()) return;
      const watched = await this.watched(message);
      if (!watched) return;
      const { settings, source } = watched;

      const ref = refOf(message, source.authorId);
      const { fresh, semanticLinks } = await this.detector.index(ref, toMessageLike(message));
      if (this.responded.has(message.id)) return;
      if ((fresh.length || semanticLinks.length) && (await this.store.responsesFor(message.id)).length) {
        this.markResponded(message.id); // answered before a restart
        return;
      }

      if (fresh.length && source.kind === 'member' && settings.relayBots.length && this.relayGraceMs > 0) {
        // A relay bot may be about to delete this post and repost the link; answer the repost instead.
        await sleep(this.relayGraceMs);
        if (!(await this.stillExists(message))) return;
      }

      if (fresh.length) {
        for (let attempt = 0; attempt < STALE_RETRIES; attempt++) {
          const match = await this.detector.findMatch(ref, fresh, settings);
          if (!match) break;
          const outcome = await respondToDuplicate(
            this.client,
            this.store,
            message,
            match.hit,
            'exact',
            settings,
            this.viewerOf(message, source),
          );
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
    const source = sourceOf(message, settings.relayBots);
    if (source.kind === 'ignored') return;
    const outcome = await respondToDuplicate(
      this.client,
      this.store,
      message,
      match.candidate,
      'semantic',
      settings,
      this.viewerOf(message, source),
    );
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
      // The repost is gone, so the original we forwarded or linked below it would dangle: remove it.
      const responses = await this.store.responsesFor(message.id);
      for (const response of responses) {
        if (!response.botMessageId) continue;
        try {
          const channel = await this.client.channels.fetch(response.channelId);
          if (channel?.isTextBased()) await channel.messages.delete(response.botMessageId);
        } catch {
          /* already gone */
        }
      }
      if (responses.length) await this.store.deleteResponses(message.id);
    } catch (err) {
      logger.warn(`[dupe] could not clean up deleted message ${message.id}: ${(err as Error).message}`);
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
    if (sub === 'relay') return this.relay(interaction);
  }

  async relay(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const action = interaction.options.getString('action', true);
    const id = interaction.options.getUser('bot')?.id ?? interaction.options.getString('id')?.trim() ?? null;
    const current = await this.store.getSettings(interaction.guildId);
    let relayBots = current.relayBots.slice();
    if (action !== 'list') {
      if (!id || !/^\d{5,25}$/.test(id)) {
        await interaction.reply({ content: '`bot` 또는 `id`(숫자 ID)를 지정해 주세요.', flags: MessageFlags.Ephemeral });
        return;
      }
      relayBots = relayBots.filter((existing) => existing !== id);
      if (action === 'add') relayBots.push(id);
    }
    const settings = action === 'list' ? current : await this.store.updateSettings(interaction.guildId, { relayBots });
    await interaction.reply({ content: this.describeSettings(settings, interaction.guildId), flags: MessageFlags.Ephemeral });
  }

  describeSettings(settings: GuildSettings, guildId: string): string {
    const channels = (ids: string[]) => (ids.length ? ids.map((id) => `<#${id}>`).join(' ') : '없음');
    return [
      `이모지: ${settings.emoji} (비슷한 내용: ${settings.semanticEmoji})`,
      `반응 방식: \`${settings.mode}\``,
      `사진 유사도 기준 (dHash): ${settings.hammingThreshold}`,
      `같은 작성자 재게시 무시: ${settings.sameAuthorMinutes ? `${settings.sameAuthorMinutes}분` : '사용 안 함'}`,
      `Claude 의미 기반 판정: ${settings.semanticEnabled ? '켜짐' : '꺼짐'}`,
      `감시 채널: ${settings.includeChannels.length ? channels(settings.includeChannels) : '전체'}`,
      `제외 채널: ${channels(settings.excludeChannels)}`,
      `링크 변환 봇(relay): ${settings.relayBots.length ? settings.relayBots.map((id) => `<@${id}>`).join(' ') : '없음'}`,
      `스티커: ${settings.stickerId ? (this.client.guilds.cache.get(guildId)?.stickers.cache.get(settings.stickerId)?.name ?? `${settings.stickerId} (서버에서 찾을 수 없음)`) : '없음'}` +
        (settings.mode === 'sticker' ? ` (이모지 반응 ${settings.stickerReact ? '함께 달기' : '안 달기'})` : ''),
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
    const sticker = interaction.options.getString('sticker')?.trim();
    const stickerReact = interaction.options.getBoolean('sticker_react');
    if (emoji) patch.emoji = emoji.trim();
    if (semanticEmoji) patch.semanticEmoji = semanticEmoji.trim();
    if (mode) patch.mode = mode as ResponseMode;
    if (threshold !== null) patch.hammingThreshold = threshold;
    if (sameAuthor !== null) patch.sameAuthorMinutes = sameAuthor;
    if (semantic !== null) patch.semanticEnabled = semantic;
    if (stickerReact !== null) patch.stickerReact = stickerReact;
    if (sticker) {
      if (sticker.toLowerCase() === 'none') {
        patch.stickerId = null;
      } else {
        const stickers = await interaction.guild.stickers.fetch();
        const found =
          stickers.get(sticker) ?? stickers.find((s) => s.name.toLowerCase() === sticker.toLowerCase());
        if (!found) {
          const names = stickers.map((s) => s.name).join(', ') || '없음';
          await interaction.reply({
            content: `이 서버에서 \`${sticker}\` 스티커를 찾지 못했어요. 사용할 수 있는 스티커: ${names}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        patch.stickerId = found.id;
      }
    }

    const settings = Object.keys(patch).length
      ? await this.store.updateSettings(interaction.guildId, patch)
      : await this.store.getSettings(interaction.guildId);
    await interaction.reply({ content: this.describeSettings(settings, interaction.guildId), flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: this.describeSettings(settings, interaction.guildId), flags: MessageFlags.Ephemeral });
  }

  async backfill(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const channel = interaction.options.getChannel('channel', true);
    const limit = interaction.options.getInteger('limit') ?? 1000;
    if (!channel.isTextBased()) {
      await interaction.reply({ content: '메시지를 읽을 수 있는 채널이 아니에요.', flags: MessageFlags.Ephemeral });
      return;
    }
    const running = this.backfilling.get(interaction.guildId);
    if (running) {
      await interaction.reply({
        content: `<#${running.channelId}> 색인이 진행 중이에요 (${running.scanned}개 확인). 끝난 뒤에 다시 실행해 주세요.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const progress: BackfillProgress = { channelId: channel.id, scanned: 0, indexed: 0, oldest: null, startedAt: Date.now() };
    this.backfilling.set(interaction.guildId, progress);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // The reply can only be edited for 15 minutes; a long backfill keeps going and reports in the log and /status.
    const update = async (text: string) => {
      try {
        await interaction.editReply(text);
      } catch {
        /* interaction token expired */
      }
    };
    const cutoff = this.retentionDays > 0 ? Date.now() - this.retentionDays * 86_400_000 : 0;
    const settings = await this.store.getSettings(interaction.guildId);
    let reachedCutoff = false;
    let before: string | undefined;
    logger.info(`[backfill] #${channel.name} started (up to ${limit} messages)`);
    try {
      while (progress.scanned < limit && !reachedCutoff) {
        const batch = await channel.messages.fetch({ limit: Math.min(100, limit - progress.scanned), before });
        if (batch.size === 0) break;
        for (const message of batch.values()) {
          if (message.createdTimestamp < cutoff) {
            reachedCutoff = true;
            break;
          }
          progress.scanned++;
          progress.oldest = message.createdAt;
          if (!message.inGuild()) continue;
          const source = sourceOf(message, settings.relayBots);
          if (source.kind === 'ignored') continue;
          const { fresh } = await this.detector.index(refOf(message, source.authorId), toMessageLike(message));
          if (fresh.length) progress.indexed++;
        }
        before = batch.last()?.id;
        if (progress.scanned % 500 < 100) {
          const until = progress.oldest ? `<t:${Math.floor(progress.oldest.getTime() / 1000)}:d>` : '';
          logger.info(`[backfill] #${channel.name}: ${progress.scanned} checked, ${progress.indexed} indexed, back to ${progress.oldest?.toISOString().slice(0, 10)}`);
          await update(`<#${channel.id}> 색인 중… ${progress.scanned}개 확인, ${until}까지`);
        }
      }
      const tail = reachedCutoff ? ` (보관 기간 ${this.retentionDays}일보다 오래된 메시지에서 멈춤)` : '';
      const summary = `<#${channel.id}> 색인 완료: 메시지 ${progress.scanned}개 확인, ${progress.indexed}개에서 링크·이미지 저장${tail}`;
      logger.info(`[backfill] #${channel.name} done: ${progress.scanned} checked, ${progress.indexed} indexed${reachedCutoff ? ', stopped at the retention window' : ''}`);
      await update(summary);
    } catch (err) {
      logger.error('[backfill] failed:', err);
      await update(`색인 중 오류가 났어요 (${progress.scanned}개까지 처리): ${(err as Error).message}`);
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
    const backfill = this.backfilling.get(interaction.guildId);
    if (backfill) {
      const until = backfill.oldest ? `, <t:${Math.floor(backfill.oldest.getTime() / 1000)}:d>까지` : '';
      embed.addFields({
        name: '과거 메시지 색인 (진행 중)',
        value: `<#${backfill.channelId}>: ${backfill.scanned}개 확인, ${backfill.indexed}개 저장${until} (시작 <t:${Math.floor(backfill.startedAt / 1000)}:R>)`,
      });
    }
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
