import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySource, type AuthorInfo } from '../src/dupe/relay.ts';

const member: AuthorInfo = { authorId: 'u1', authorIsBot: false, webhookId: null, applicationId: null, mentionedUserIds: [] };
const arona: AuthorInfo = { authorId: 'bot-arona', authorIsBot: true, webhookId: null, applicationId: 'app-arona', mentionedUserIds: ['u1', 'u2'] };

test('a member post counts as that member', () => {
  assert.deepEqual(classifySource(member, [], 'self'), { kind: 'member', authorId: 'u1' });
});

test('bots and webhooks are ignored unless listed', () => {
  assert.deepEqual(classifySource(arona, [], 'self'), { kind: 'ignored' });
  assert.deepEqual(classifySource({ ...member, webhookId: 'wh1' }, [], 'self'), { kind: 'ignored' });
});

test('a listed relay bot post counts as the first member it mentions', () => {
  assert.deepEqual(classifySource(arona, ['bot-arona'], 'self'), { kind: 'relay', authorId: 'u1', botId: 'bot-arona' });
});

test('a relay bot can be listed by its application or webhook ID', () => {
  assert.equal(classifySource(arona, ['app-arona'], 'self').kind, 'relay');
  const hook: AuthorInfo = { ...arona, authorId: 'wh9', webhookId: 'wh9', applicationId: null };
  assert.equal(classifySource(hook, ['wh9'], 'self').kind, 'relay');
});

test('a relay post without a mention counts as the bot itself', () => {
  assert.deepEqual(classifySource({ ...arona, mentionedUserIds: [] }, ['bot-arona'], 'self'), {
    kind: 'relay',
    authorId: 'bot-arona',
    botId: 'bot-arona',
  });
});

test('our own messages are never indexed, even if listed', () => {
  assert.deepEqual(classifySource({ ...arona, authorId: 'self' }, ['self'], 'self'), { kind: 'ignored' });
});
