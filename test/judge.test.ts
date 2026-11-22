import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { AUTH_COOLDOWN_MS, parseVerdict, SemanticJudge, TRANSIENT_COOLDOWN_MS, type LlmClient } from '../src/semantic/judge.ts';
import { MemoryStore } from './memory-store.ts';

const subject = { host: 'news.example', title: '서울에 첫눈', description: '오늘 아침 서울에 첫눈이 내렸다' };
const candidates = [
  { title: '부산 날씨', description: '맑음' },
  { title: '서울 첫눈 관측', description: '기상청은 오늘 서울에 첫눈이 왔다고 밝혔다' },
];

function message(text: string, stop: Anthropic.Message['stop_reason'] = 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 20 },
  } as unknown as Anthropic.Message;
}

/** A fake client that answers with the queued results in order (an Error is thrown). */
function fakeClient(results: (Anthropic.Message | Error)[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: LlmClient = {
    messages: {
      async create(params) {
        calls.push(params);
        const next = results.shift();
        if (!next) throw new Error('no more fake results');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { client, calls };
}

function apiError(status: number) {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: `status ${status}` } }, `status ${status}`, new Headers());
}

function makeJudge(client: LlmClient | null, extra: { budget?: number; now?: () => number } = {}) {
  const store = new MemoryStore();
  const judge = new SemanticJudge({
    client,
    model: 'claude-haiku-5-5',
    usage: store,
    dailyBudgetUsd: extra.budget ?? 0.5,
    priceInputPerMTok: 0.1,
    priceOutputPerMTok: 0.5,
    now: extra.now,
  });
  return { judge, store };
}

test('no API key: disabled, never calls anything', async () => {
  const { judge } = makeJudge(null);
  assert.equal(judge.isAvailable(), false);
  assert.equal(await judge.judge(subject, candidates), null);
  assert.equal((await judge.status()).state, 'disabled');
});

test('a valid answer is returned and its cost recorded', async () => {
  const { client, calls } = fakeClient([message('{"match_index": 1, "confidence": 0.93}')]);
  const { judge, store } = makeJudge(client);
  assert.deepEqual(await judge.judge(subject, candidates), { index: 1, confidence: 0.93 });
  const params = calls[0];
  assert.equal(params.model, 'claude-haiku-5-5');
  assert.deepEqual(params.thinking, { type: 'disabled' });
  assert.equal(params.output_config?.effort, 'low');
  assert.equal(params.output_config?.format?.type, 'json_schema');
  const today = new Date().toISOString().slice(0, 10);
  const usage = await store.getLlmUsage(today);
  assert.equal(usage.calls, 1);
  assert.ok(Math.abs(usage.usd - (1000 * 0.1 + 20 * 0.5) / 1e6) < 1e-12);
});

test('null match, refusal, truncated output and malformed JSON all mean "no match" without a pause', async () => {
  const { client } = fakeClient([
    message('{"match_index": null, "confidence": 0.2}'),
    message('', 'refusal'),
    message('{"match_index": 1, "conf', 'max_tokens'),
    message('not json'),
    message('{"match_index": 7, "confidence": 0.9}'), // index out of range
    message('{"match_index": 1, "confidence": 1.5}'), // confidence out of range
  ]);
  const { judge } = makeJudge(client);
  for (let i = 0; i < 6; i++) assert.equal(await judge.judge(subject, candidates), null, `case ${i}`);
  assert.equal(judge.isAvailable(), true);
});

test('an auth error pauses for 30 min; a rate limit for 60 s', async () => {
  let now = 1_000_000;
  const { client, calls } = fakeClient([apiError(401), apiError(429), message('{"match_index": 0, "confidence": 0.9}')]);
  const { judge } = makeJudge(client, { now: () => now });

  assert.equal(await judge.judge(subject, candidates), null);
  assert.equal((await judge.status()).state, 'cooldown');
  now += AUTH_COOLDOWN_MS - 1;
  assert.equal(await judge.judge(subject, candidates), null);
  assert.equal(calls.length, 1, 'not called during the pause');

  now += 1;
  assert.equal(await judge.judge(subject, candidates), null); // 429
  assert.equal(judge.cooldownUntil, now + TRANSIENT_COOLDOWN_MS);
  now += TRANSIENT_COOLDOWN_MS;
  assert.deepEqual(await judge.judge(subject, candidates), { index: 0, confidence: 0.9 });
});

test('connection errors are transient too', async () => {
  const { client } = fakeClient([new Anthropic.APIConnectionError({ message: 'ECONNRESET' })]);
  const { judge } = makeJudge(client);
  assert.equal(await judge.judge(subject, candidates), null);
  assert.equal(judge.state, 'cooldown');
  assert.equal(judge.reason, 'transient network');
});

test('a retired model (404/410) switches the feature off at the startup probe', async () => {
  for (const status of [404, 410]) {
    const { client, calls } = fakeClient([apiError(status)]);
    const { judge } = makeJudge(client);
    await judge.probe();
    assert.equal((await judge.status()).state, 'failed');
    assert.equal(await judge.judge(subject, candidates), null);
    assert.equal(calls.length, 1);
  }
});

test('once the daily budget is spent no call is made until the UTC day changes', async () => {
  let now = Date.parse('2026-11-22T10:00:00Z');
  const { client, calls } = fakeClient([message('{"match_index": 0, "confidence": 0.9}'), message('{"match_index": 0, "confidence": 0.9}')]);
  const { judge, store } = makeJudge(client, { budget: 0.01, now: () => now });
  await store.addLlmUsage('2026-11-22', 0, 0, 0.01);
  assert.equal(await judge.judge(subject, candidates), null);
  assert.equal((await judge.status()).state, 'budget');
  assert.equal(calls.length, 0);
  now = Date.parse('2026-11-23T00:00:01Z');
  assert.ok(await judge.judge(subject, candidates));
});

test('parseVerdict validation', () => {
  assert.deepEqual(parseVerdict('{"match_index":0,"confidence":0}', 1), { index: 0, confidence: 0 });
  assert.equal(parseVerdict('{"match_index":0.5,"confidence":0.9}', 2), null);
  assert.equal(parseVerdict('[]', 2), null);
  assert.equal(parseVerdict('{"confidence":0.9}', 2), null);
});
