// Environment configuration. Docker Compose passes .env through env_file; for `npm run dev`
// a local .env is loaded with Node's built-in loader when present (no dotenv dependency).
import { existsSync } from 'node:fs';
import { RESPONSE_MODES, type ResponseMode } from './modes.ts';

export type { ResponseMode };

if (existsSync('.env')) process.loadEnvFile('.env');

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] ${name} is required`);
    process.exit(1);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`[config] ${name} must be a non-negative number (got "${raw}")`);
    process.exit(1);
  }
  return value;
}


function mode(name: string, fallback: ResponseMode): ResponseMode {
  const value = optional(name, fallback).toLowerCase();
  if (!(RESPONSE_MODES as readonly string[]).includes(value)) {
    console.error(`[config] ${name} must be one of ${RESPONSE_MODES.join(', ')} (got "${value}")`);
    process.exit(1);
  }
  return value as ResponseMode;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  databaseUrl: required('DATABASE_URL'),

  // How long indexed messages are kept (days). Older entries are purged once a day.
  retentionDays: number('RETENTION_DAYS', 90),

  // Image handling
  imageMaxBytes: number('IMAGE_MAX_BYTES', 20 * 1024 * 1024),
  imageMinSize: number('IMAGE_MIN_SIZE', 64),

  // Per-guild defaults (changeable with /dupe config)
  defaults: {
    emoji: optional('DEFAULT_EMOJI', '🔁'),
    semanticEmoji: optional('DEFAULT_SEMANTIC_EMOJI', '🤔'),
    mode: mode('DEFAULT_MODE', 'forward'),
    hammingThreshold: number('DEFAULT_HAMMING_THRESHOLD', 6),
    sameAuthorMinutes: number('DEFAULT_SAME_AUTHOR_MINUTES', 10),
  },

  // Claude semantic matching (optional; no key = disabled, everything else keeps working)
  anthropicApiKey: optional('ANTHROPIC_API_KEY', ''),
  anthropicModel: optional('ANTHROPIC_MODEL', 'claude-haiku-5-5'),
  llmTimeoutMs: number('LLM_TIMEOUT_MS', 10000),
  llmDailyBudgetUsd: number('LLM_DAILY_BUDGET_USD', 0.5),
  llmPriceInputPerMTok: number('LLM_PRICE_INPUT_PER_MTOK', 0.1),
  llmPriceOutputPerMTok: number('LLM_PRICE_OUTPUT_PER_MTOK', 0.5),
  semanticMinConfidence: number('SEMANTIC_MIN_CONFIDENCE', 0.85),
  semanticWindowDays: number('SEMANTIC_WINDOW_DAYS', 14),
  semanticMaxCandidates: number('SEMANTIC_MAX_CANDIDATES', 5),
  semanticMinSimilarity: number('SEMANTIC_MIN_SIMILARITY', 0.15),
  semanticMaxBacklog: number('SEMANTIC_MAX_BACKLOG', 20),
};
