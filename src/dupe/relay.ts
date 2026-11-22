// Link-fixer bots (an app that deletes a member's x.com link and reposts it as fixupx.com, for
// example) post on the member's behalf. Messages from bots and webhooks are ignored unless the
// server lists the bot with `/dupe relay`; a listed bot's post counts as the first member it
// mentions, so the same-author rule and the private-channel check apply to that member.

export interface AuthorInfo {
  authorId: string;
  authorIsBot: boolean;
  webhookId: string | null;
  applicationId: string | null;
  /** IDs of mentioned users that are not bots, in mention order */
  mentionedUserIds: string[];
}

export type Source =
  | { kind: 'member'; authorId: string }
  | { kind: 'relay'; authorId: string; botId: string }
  | { kind: 'ignored' };

export function classifySource(info: AuthorInfo, relayBots: readonly string[], selfId: string | null): Source {
  if (selfId && info.authorId === selfId) return { kind: 'ignored' };
  if (!info.authorIsBot && !info.webhookId) return { kind: 'member', authorId: info.authorId };
  const botId = [info.authorId, info.webhookId, info.applicationId].find((id) => id && relayBots.includes(id));
  if (!botId) return { kind: 'ignored' };
  return { kind: 'relay', authorId: info.mentionedUserIds[0] ?? info.authorId, botId };
}
