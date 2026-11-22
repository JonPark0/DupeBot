import {
  type Client,
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
  const action = chooseAction({
    mode: settings.mode,
    kind,
    sameChannel: original.channel.id === message.channelId,
    authorCanView: original.channel.permissionsFor(message.member ?? message.author.id)?.has(VIEW) ?? false,
    everyoneCanView: original.channel.permissionsFor(everyone)?.has(VIEW) ?? false,
  });
  const emoji = kind === 'semantic' ? settings.semanticEmoji : settings.emoji;

  try {
    await message.react(emoji);
  } catch (err) {
    logger.warn(`[respond] could not react with ${emoji} in #${message.channelId}: ${(err as Error).message}`);
  }
  await store.recordResponse(message.id, { channelId: message.channelId, botMessageId: null, kind });

  if (action === 'react') return 'done';

  try {
    let sent: Message;
    if (action === 'forward') {
      sent = await original.message.forward(message.channel);
    } else {
      const when = Math.floor(original.message.createdTimestamp / 1000);
      const lead = kind === 'semantic' ? '비슷한 내용이 이전에 올라왔어요' : '이전에 올라온 게시물이에요';
      sent = await message.reply({
        content: `${emoji} ${lead}: ${original.message.url} (<@${original.message.author.id}>, <t:${when}:R>)`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
    await store.recordResponse(message.id, { channelId: sent.channelId, botMessageId: sent.id, kind });
  } catch (err) {
    logger.warn(`[respond] ${action} failed for ${message.id}: ${(err as Error).message}`);
  }
  return 'done';
}
