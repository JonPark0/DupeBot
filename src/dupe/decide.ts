import type { ResponseMode } from '../modes.ts';
import type { ResponseKind } from '../store/types.ts';

// How to answer a duplicate. Pure, so the privacy rule is easy to test.

/** sticker: a reply with the server's sticker and a link to the original; sticker-only: the sticker without the link */
export type Action = 'forward' | 'reply' | 'react' | 'sticker' | 'sticker-only';

export interface DecisionInput {
  mode: ResponseMode;
  kind: ResponseKind;
  /** the original was posted in the same channel as the repost */
  sameChannel: boolean;
  /** the repost's author can read the original's channel */
  authorCanView: boolean;
  /** @everyone can read the original's channel */
  everyoneCanView: boolean;
  /** the server has a usable sticker set (sticker mode falls back to a link reply without one) */
  hasSticker?: boolean;
}

/**
 * Forwarding copies the original into the repost's channel, and a reply names its author and
 * date. Do either only when the original is visible to everyone who could see the answer;
 * otherwise just react, so nothing from a private channel leaks. A semantic (Claude) match is
 * less certain, so it gets a reply with a link, never a forwarded copy.
 */
export function chooseAction(input: DecisionInput): Action {
  const shareable = input.sameChannel || (input.authorCanView && input.everyoneCanView);
  if (input.mode === 'react') return 'react';
  if (input.mode === 'sticker' && input.kind === 'exact' && input.hasSticker) {
    // the sticker reveals nothing about the original; only the link does
    return shareable ? 'sticker' : 'sticker-only';
  }
  if (!shareable) return 'react';
  if (input.kind === 'semantic' || input.mode === 'sticker') return 'reply';
  return input.mode;
}
