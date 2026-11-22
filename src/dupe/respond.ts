import {
  type Client,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  DiscordAPIError,
} from 'discord.js';
import { logger } from '../logger.ts';
import type { GuildSettings, MessageRef, ResponseKind, Store } from '../store/types.ts';
import { chooseAction } from './decide.ts';

// The Discord side of a duplicate: react, then forward the original or reply with a link.

export type RespondOutcome = 'done' | 'stale' | 'failed';

const VIEW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

function isUnknown(err: unknown): boolean {
  return (
    err instanceof DiscordAPIError &&
    (err.code === RESTJSONErrorCodes.UnknownMessage || err.code === RESTJSONErrorCodes.UnknownChannel)
  );
}

async function fetchOriginal(client: Client, hit: MessageRef): Promise<{ channel: GuildTextBasedChannel; message: Message<true> } | null> {
  try {
    const channel = await client.channels.fetch(hit.channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
    const message = await channel.messages.fetch(hit.messageId);
    return { channel, message };
  } catch (err) {
    if (isUnknown(err)) return null;
    throw err;
  }
}

/**
 * Answer `message` as a repost of `hit`. Returns 'stale' when the original no longer exists
 * (it is removed from the index, so the caller can look for the next-oldest post).
 */
export async function respondToDuplicate(
  client: Client,
  store: Store,
  message: Message<true>,
  hit: MessageRef,
  kind: ResponseKind,
  settings: GuildSettings,
  /** whose access decides what may be shared: the poster, or the member a relay bot posted for */
  viewer: GuildMember | string,
): Promise<RespondOutcome> {
  let original;
  try {
    original = await fetchOriginal(client, hit);
  } catch (err) {
    logger.warn(`[respond] could not fetch original ${hit.messageId}: ${(err as Error).message}`);
    return 'failed';
  }
  if (!original) {
    await store.removeMessage(hit.messageId);
    return 'stale';
  }

  const everyone = message.guild.roles.everyone;
  // A sticker added after startup is not cached (no expressions intent); look it up once.
  const sticker = settings.stickerId
    ? (message.guild.stickers.cache.get(settings.stickerId) ??
      (await message.guild.stickers.fetch(settings.stickerId).catch(() => null)))
    : null;
  const action = chooseAction({
    mode: settings.mode,
    kind,
    sameChannel: original.channel.id === message.channelId,
    authorCanView: original.channel.permissionsFor(viewer)?.has(VIEW) ?? false,
    everyoneCanView: original.channel.permissionsFor(everyone)?.has(VIEW) ?? false,
    hasSticker: sticker !== null,
  });
  const emoji = kind === 'semantic' ? settings.semanticEmoji : settings.emoji;
  const isSticker = action === 'sticker' || action === 'sticker-only';
  const when = Math.floor(original.message.createdTimestamp / 1000);
  const link = (lead: string) => `${lead}: ${original.message.url} (<@${hit.authorId}>, <t:${when}:R>)`;

  const react = async () => {
    try {
      await message.react(emoji);
    } catch (err) {
      logger.warn(`[respond] could not react with ${emoji} in #${message.channelId}: ${(err as Error).message}`);
    }
  };
  if (!isSticker || settings.stickerReact) await react();
  await store.recordResponse(message.id, { channelId: message.channelId, botMessageId: null, kind });

  if (action === 'react') return 'done';

  try {
    let sent: Message;
    if (action === 'forward') {
      sent = await original.message.forward(message.channel);
    } else if (isSticker) {
      try {
        sent = await message.reply({
          ...(action === 'sticker' ? { content: link('이전에 올라온 게시물이에요') } : {}),
          stickers: [settings.stickerId!],
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch (err) {
        // the sticker was deleted or can't be sent: fall back to the emoji (and the link, if it may be shared)
        logger.warn(`[respond] sticker ${settings.stickerId} failed (${(err as Error).message}), using the emoji instead`);
        if (!settings.stickerReact) await react();
        if (action === 'sticker-only') return 'done';
        sent = await message.reply({
          content: `${emoji} ${link('이전에 올라온 게시물이에요')}`,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }
    } else {
      const lead = kind === 'semantic' ? '비슷한 내용이 이전에 올라왔어요' : '이전에 올라온 게시물이에요';
      sent = await message.reply({
        content: `${emoji} ${link(lead)}`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
    await store.recordResponse(message.id, { channelId: sent.channelId, botMessageId: sent.id, kind });
  } catch (err) {
    logger.warn(`[respond] ${action} failed for ${message.id}: ${(err as Error).message}`);
  }
  return 'done';
}
