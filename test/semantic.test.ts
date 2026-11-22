import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { findSemanticMatch } from '../src/dupe/semantic.ts';
import { SemanticJudge, type LlmClient } from '../src/semantic/judge.ts';
import { DEFAULT_SETTINGS, MemoryStore } from './memory-store.ts';

const T0 = Date.parse('2026-11-22T00:00:00Z');
const ref = { guildId: 'g1', channelId: 'c1', messageId: 'new', authorId: 'bob', postedAt: new Date(T0 + 3_600_000) };
const link = { key: 'k-new', normalized: 'news.b/2', title: '서울 첫눈', description: '오늘 서울에 첫눈' };
const options = { windowDays: 14, maxCandidates: 5, minSimilarity: 0.15, minConfidence: 0.85 };

function judgeAnswering(text: string) {
  let calls = 0;
  const client: LlmClient = {
    messages: {
      async create() {
        calls++;
        return {
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        } as unknown as Anthropic.Message;
      },
    },
  };
  const store = new MemoryStore();
  store.candidates = [
    { guildId: 'g1', channelId: 'c1', messageId: 'old', authorId: 'alice', postedAt: new Date(T0), title: '첫눈 관측', description: null, similarity: 0.4 },
  ];
  const judge = new SemanticJudge({ client, model: 'm', usage: store, dailyBudgetUsd: 0, priceInputPerMTok: 0.1, priceOutputPerMTok: 0.5 });
  return { store, judge, calls: () => calls };
}

test('a confident answer returns the candidate', async () => {
  const { store, judge } = judgeAnswering('{"match_index": 0, "confidence": 0.9}');
  const match = await findSemanticMatch(store, judge, ref, link, DEFAULT_SETTINGS, options);
  assert.equal(match?.candidate.messageId, 'old');
});

test('below the confidence threshold: no match', async () => {
  const { store, judge } = judgeAnswering('{"match_index": 0, "confidence": 0.6}');
  assert.equal(await findSemanticMatch(store, judge, ref, link, DEFAULT_SETTINGS, options), null);
});

test('no candidates, semantic off, or an allowlisted link: Claude is not called', async () => {
  const off = judgeAnswering('{"match_index": 0, "confidence": 0.9}');
  assert.equal(await findSemanticMatch(off.store, off.judge, ref, link, { ...DEFAULT_SETTINGS, semanticEnabled: false }, options), null);

  const empty = judgeAnswering('{"match_index": 0, "confidence": 0.9}');
  empty.store.candidates = [];
  assert.equal(await findSemanticMatch(empty.store, empty.judge, ref, link, DEFAULT_SETTINGS, options), null);

  const allowed = judgeAnswering('{"match_index": 0, "confidence": 0.9}');
  await allowed.store.addAllowlist('g1', [{ kind: 'url', key: 'k-new', dhash: null, title: null, description: null }]);
  assert.equal(await findSemanticMatch(allowed.store, allowed.judge, ref, link, DEFAULT_SETTINGS, options), null);

  assert.equal(off.calls() + empty.calls() + allowed.calls(), 0);
});
