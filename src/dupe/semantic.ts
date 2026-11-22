import type { LinkItem } from '../detect/collect.ts';
import type { SemanticJudge } from '../semantic/judge.ts';
import type { GuildSettings, MessageRef, SemanticCandidate, Store } from '../store/types.ts';
import { isOwnRecentRepost } from './detector.ts';

export interface SemanticOptions {
  windowDays: number;
  maxCandidates: number;
  minSimilarity: number;
  minConfidence: number;
}

export interface SemanticMatch {
  candidate: SemanticCandidate;
  confidence: number;
}

function hostOf(normalized: string): string {
  return normalized.split(/[/?:]/)[0];
}

/**
 * Second opinion for a link that matched nothing exactly: shortlist recent links with similar
 * preview text (pg_trgm), then let Claude decide whether one is the same story. Any failure
 * along the way means "no match".
 */
export async function findSemanticMatch(
  store: Store,
  judge: SemanticJudge,
  ref: MessageRef,
  link: LinkItem,
  settings: GuildSettings,
  options: SemanticOptions,
): Promise<SemanticMatch | null> {
  if (!settings.semanticEnabled || !link.title || !judge.isAvailable()) return null;
  const text = [link.title, link.description].filter(Boolean).join(' ');
  if (await store.isAllowlisted(ref.guildId, { kind: 'url', key: link.key, dhash: null, title: null, description: null }, 0)) {
    return null;
  }
  const candidates = (
    await store.semanticCandidates(ref, text, {
      sinceDays: options.windowDays,
      limit: options.maxCandidates,
      minSimilarity: options.minSimilarity,
      excludeKeys: [link.key],
    })
  ).filter((candidate) => !isOwnRecentRepost(ref, candidate, settings.sameAuthorMinutes));
  if (candidates.length === 0) return null;

  const verdict = await judge.judge(
    { host: hostOf(link.normalized), title: link.title, description: link.description },
    candidates.map((candidate) => ({ title: candidate.title, description: candidate.description })),
  );
  if (!verdict || verdict.confidence < options.minConfidence) return null;
  return { candidate: candidates[verdict.index], confidence: verdict.confidence };
}
