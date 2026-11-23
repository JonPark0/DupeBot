# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

DupeBot is a Discord bot that spots reposted links and images in a server, reacts with an emoji
and forwards (or links) the original post right below. Optional Claude (Haiku) check for the same
story posted under a different URL. Self-hosted with Docker Compose on an arm64 home server.

**Stack:** TypeScript 7, Node.js 26, discord.js v14, PostgreSQL 18 (own container, `pg_trgm`), sharp,
`@anthropic-ai/sdk`.

## Layout

- [src/index.ts](src/index.ts): startup: schema migration (retries until Postgres is up), Discord client, command registration, daily purge
- [src/bot.ts](src/bot.ts): event handlers (create/update/delete) and commands (`/dupe`, `/status`, "중복 아님")
- [src/detect/](src/detect/): URL normalization, image hashing (sha256 + dHash), video sha256 (streamed), what to collect from a message
- [src/dupe/detector.ts](src/dupe/detector.ts): index a message, find the earliest match
- [src/dupe/decide.ts](src/dupe/decide.ts): forward / reply / react, including the private-channel rule
- [src/dupe/respond.ts](src/dupe/respond.ts): the Discord side of a response
- [src/dupe/relay.ts](src/dupe/relay.ts): which bot posts count (link-fixer relay bots) and as whom
- [src/semantic/judge.ts](src/semantic/judge.ts): Claude call with cooldowns, daily budget, startup probe; every failure returns null
- [src/store/](src/store/): `Store` interface and `PgStore`; tests use `test/memory-store.ts`
- [database/init.sql](database/init.sql): schema, applied by the bot on every start (idempotent)

## Commands

```bash
npm install
npm run typecheck
npm test                 # no DB / Discord / network needed
npm run build            # dist/ (what the image runs: node dist/index.js)
docker compose up -d --build
docker compose logs -f dupe-bot
docker compose exec postgres psql -U dupebot -d dupebot
```

## Source rules (Node runs src/*.ts directly in dev)

- Relative imports use the `.ts` extension; `tsc` rewrites them to `.js` in `dist/`
- Type-only imports use `import type` / `{ type X }`
- No `enum`, `namespace` or constructor parameter properties; use `as const` objects
- `src/config.ts` reads the environment on import (and exits on missing values): modules that tests
  import must not import it at runtime; shared constants live in `src/modes.ts`

## Invariants

- Exact matching never depends on the Claude API. `SemanticJudge.judge()` returns null on any failure.
- Only fingerprints are stored (hashes, IDs, timestamps, link preview title/description); no message text, no images.
- Never forward or link an original the repost's audience can't see (`chooseAction`).
- Backfill indexes without reacting.
- Bot and webhook posts are ignored unless the guild lists them with `/dupe relay`; a listed bot's post
  counts as the first member it mentions (`src/dupe/relay.ts`).
