import Anthropic from '@anthropic-ai/sdk';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { Bot } from './bot.ts';
import { commandBodies } from './commands/definitions.ts';
import { CommandRegistry } from './commands/registry.ts';
import { config } from './config.ts';
import { downloadImage, hashImage } from './detect/image.ts';
import { Detector } from './dupe/detector.ts';
import { logger } from './logger.ts';
import { SemanticJudge } from './semantic/judge.ts';
import { PgStore } from './store/pg.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const store = new PgStore(config.databaseUrl, {
  emoji: config.defaults.emoji,
  semanticEmoji: config.defaults.semanticEmoji,
  mode: config.defaults.mode,
  hammingThreshold: config.defaults.hammingThreshold,
  sameAuthorMinutes: config.defaults.sameAuthorMinutes,
  semanticEnabled: true,
  includeChannels: [],
  excludeChannels: [],
  relayBots: [],
});

// Postgres may still be starting when the bot does; retry instead of crash-looping.
for (let attempt = 1; ; attempt++) {
  try {
    await store.migrate();
    break;
  } catch (err) {
    if (attempt >= 10) {
      logger.error('[db] could not reach Postgres:', err);
      process.exit(1);
    }
    logger.warn(`[db] Postgres not ready (${(err as Error).message}), retrying in 3 s`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
logger.info('[db] schema ready');

const judge = new SemanticJudge({
  client: config.anthropicApiKey
    ? new Anthropic({ apiKey: config.anthropicApiKey, timeout: config.llmTimeoutMs, maxRetries: 1 })
    : null,
  model: config.anthropicModel,
  usage: store,
  dailyBudgetUsd: config.llmDailyBudgetUsd,
  priceInputPerMTok: config.llmPriceInputPerMTok,
  priceOutputPerMTok: config.llmPriceOutputPerMTok,
});

const detector = new Detector({
  store,
  imageMaxBytes: config.imageMaxBytes,
  hashImageUrl: async (url) => {
    const bytes = await downloadImage(url, config.imageMaxBytes);
    return bytes ? hashImage(bytes, config.imageMinSize) : null;
  },
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  // deletes and edits of messages sent before the bot started arrive as partials
  partials: [Partials.Message, Partials.Channel],
});

const bot = new Bot({
  client,
  store,
  detector,
  judge,
  semantic: {
    windowDays: config.semanticWindowDays,
    maxCandidates: config.semanticMaxCandidates,
    minSimilarity: config.semanticMinSimilarity,
    minConfidence: config.semanticMinConfidence,
  },
  semanticMaxBacklog: config.semanticMaxBacklog,
  retentionDays: config.retentionDays,
  relayGraceMs: config.relayGraceMs,
  startedAt: Date.now(),
});

const registry = new CommandRegistry(config.discordToken, config.discordClientId);

client.once(Events.ClientReady, async (ready) => {
  logger.info(`[discord] logged in as ${ready.user.tag}, ${ready.guilds.cache.size} guild(s)`);
  try {
    const removed = await registry.clearGlobal();
    if (removed) logger.info(`[discord] removed ${removed} global command(s)`);
  } catch (err) {
    logger.warn('[discord] could not clear global commands:', err);
  }
  let synced = 0;
  for (const guild of ready.guilds.cache.values()) {
    try {
      await registry.syncGuild(guild.id, commandBodies);
      synced++;
    } catch (err) {
      logger.warn(`[discord] could not register commands in ${guild.id}:`, err);
    }
  }
  logger.info(`[discord] slash commands registered in ${synced}/${ready.guilds.cache.size} guild(s)`);
  await judge.probe();
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    await registry.syncGuild(guild.id, commandBodies);
    logger.info(`[discord] joined ${guild.id}, commands registered`);
  } catch (err) {
    logger.warn(`[discord] could not register commands in ${guild.id}:`, err);
  }
});

client.on(Events.MessageCreate, (message) => void bot.onMessage(message));
client.on(Events.MessageUpdate, (_old, message) => void bot.onMessage(message));
client.on(Events.MessageDelete, (message) => void bot.onMessageDelete(message));
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await bot.onCommand(interaction);
    else if (interaction.isMessageContextMenuCommand()) await bot.onNotDuplicate(interaction);
  } catch (err) {
    logger.error('[discord] command failed:', err);
    if (interaction.isRepliable() && !interaction.replied) {
      const content = '처리 중 오류가 났어요.';
      await (interaction.deferred
        ? interaction.editReply(content)
        : interaction.reply({ content, flags: MessageFlags.Ephemeral })
      ).catch(() => undefined);
    }
  }
});

async function purge() {
  try {
    const removed = await store.purge(config.retentionDays);
    if (removed) logger.info(`[db] purged ${removed} fingerprint(s) older than ${config.retentionDays} days`);
  } catch (err) {
    logger.warn(`[db] purge failed: ${(err as Error).message}`);
  }
}
await purge();
setInterval(purge, DAY_MS).unref();

async function shutdown(signal: string) {
  logger.info(`[bot] ${signal}, shutting down`);
  await client.destroy();
  await store.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await client.login(config.discordToken);
