# 유즈 (Yuzu) — Discord 중복 게시물 감지 봇

서버에 올라오는 글을 지켜보다가 **이전에 올라왔던 링크나 사진이 다시 올라오면** 이모지로 반응하고,
원본 게시물을 바로 아래에 전달(Forward)하거나 링크로 답장합니다.

- **링크**: 추적 파라미터·모바일 주소·embed 우회 도메인(fxtwitter 등)을 정규화해서 비교
- **사진**: 같은 파일(SHA-256)뿐 아니라 재압축·크기 변경된 같은 사진(64비트 dHash)도 감지
- **비슷한 기사 (선택)**: 다른 주소로 올라온 같은 기사·영상을 Claude(Haiku)가 판정
  — API 키가 없거나 API가 실패해도 나머지 기능은 그대로 동작
- 메시지 원문과 이미지 파일은 저장하지 않습니다 (해시, Discord ID, 시각, 링크 미리보기 제목·설명만 저장)

## 구성

```
유즈 (TypeScript, Node.js 26, discord.js v14)
├── Discord Gateway (메시지 생성·수정·삭제 이벤트)
├── PostgreSQL 18 (전용 컨테이너, pg_trgm)
└── Claude API (선택, 의미 기반 판정)
```

## 설치

### 1. Discord 봇 만들기

1. [Developer Portal](https://discord.com/developers/applications) → New Application
2. **Bot** 탭 → Token 복사 → `DISCORD_TOKEN`, General Information의 Application ID → `DISCORD_CLIENT_ID`
3. **Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT** 켜기 (필수)
4. **OAuth2 → URL Generator**: scopes `bot`, `applications.commands`, 권한은 아래 표의 항목 선택 후 초대

| 권한 | 용도 |
|---|---|
| View Channels | 메시지 읽기 |
| Read Message History | 원본 메시지 조회, `/dupe backfill` |
| Add Reactions | 중복 표시 이모지 |
| Send Messages / Send Messages in Threads | 원본 전달, 링크 답장 |
| Embed Links | 답장 링크 미리보기 |

필요한 Gateway Intent: `Guilds`, `GuildMessages`, `MessageContent`

### 2. 실행

```bash
cp .env.example .env   # DISCORD_TOKEN, DISCORD_CLIENT_ID, POSTGRES_PASSWORD 입력
docker compose pull
docker compose up -d
docker compose logs -f dupe-bot
```

- 이미지는 GitHub Actions가 빌드해 `ghcr.io/jonpark0/dupebot`에 올립니다. 로컬 빌드: `docker compose up -d --build`
- DB는 이 compose의 전용 `postgres:18-alpine` 컨테이너(`yuzu-postgres`)를 씁니다. 다른 봇의 DB와 공유하지 않습니다.
- 스키마(`database/init.sql`)는 봇이 시작할 때마다 적용합니다(모두 `IF NOT EXISTS`). 백업 설정은 없습니다.

## 명령어

| 명령 | 권한 | 설명 |
|---|---|---|
| `/dupe config` | 서버 관리 | 옵션 없이 실행하면 현재 설정 표시. `emoji`, `semantic_emoji`, `mode`(forward/reply/react), `threshold`(사진 유사도), `same_author_minutes`, `semantic`(Claude 판정 on/off) |
| `/dupe channel` | 서버 관리 | `include`(감시 목록에 추가 — 목록이 있으면 그 채널만 감시), `exclude`(제외), `remove`, `clear`(모든 채널 감시) |
| `/dupe backfill` | 서버 관리 | 과거 메시지 색인 (기본 1000개, 최대 20000개). **반응은 달지 않습니다** |
| `/status` | 모두 | DB 상태, Claude 상태(켜짐/일시 중지/예산 소진/꺼짐), 오늘 사용량, 색인 수 |
| 메시지 우클릭 → 앱 → **중복 아님** | 메시지 관리 | 유즈의 반응·전달·답장을 지우고, 그 링크·사진을 앞으로 중복으로 보지 않음 |

스레드는 상위 채널의 감시/제외 설정을 따릅니다.

## 동작

1. 메시지가 올라오면 링크와 사진을 지문(해시)으로 만들어 저장합니다.
   Discord가 링크 미리보기(embed)를 나중에 붙이면 수정 이벤트에서 다시 확인합니다.
2. 같은 서버에 더 오래된 같은 지문이 있으면 반응합니다. 확인 순서: 같은 링크 → 같은 사진 파일 → 비슷한 사진(dHash)
3. 반응 방식 (`mode`):
   - `forward` (기본): 이모지 + 원본 메시지를 바로 아래에 전달
   - `reply`: 이모지 + "이전에 올라온 게시물이에요: 링크 (작성자, 시각)" 답장 (알림 없음)
   - `react`: 이모지만
4. **비공개 채널 보호**: 원본이 다른 채널에 있고 @everyone 또는 새 작성자가 그 채널을 볼 수 없으면
   전달·답장 없이 이모지만 답니다.
5. 감지하지 않는 것: 봇·웹훅 메시지, 전달(Forward)된 메시지, tenor/giphy 반응 GIF, Discord 자체 링크,
   기사 미리보기 썸네일(사이트 로고가 여러 기사에 재사용되므로), 64px 미만 이미지,
   같은 작성자가 `same_author_minutes`(기본 10분) 안에 다시 올린 것
6. 원본이 삭제됐으면 색인에서 지우고 그다음으로 오래된 게시물을 원본으로 씁니다.
7. `RETENTION_DAYS`(기본 90일)가 지난 지문은 매일 삭제합니다.

### 비슷한 기사 판정 (Claude, 선택)

정확히 일치하는 것이 없는 링크만 대상입니다.

1. 최근 14일 링크 중 미리보기 제목·설명이 비슷한 것(pg_trgm)을 최대 5개 고릅니다. 후보가 없으면 Claude를 부르지 않습니다.
2. Claude(`claude-haiku-5-5`, thinking off, effort low, JSON 스키마 출력)가 "같은 기사·사건·영상인가"를 판정합니다.
3. 확신도가 `SEMANTIC_MIN_CONFIDENCE`(기본 0.85) 이상이면 **다른 이모지**(🤔) + **링크 답장**만 답니다 (전달하지 않음).
4. 판정은 대기열에서 한 번에 하나씩 처리하고, 밀리면(`SEMANTIC_MAX_BACKLOG`) 새 요청은 건너뜁니다.

미리보기 텍스트는 웹페이지에서 온 신뢰할 수 없는 데이터로 취급합니다: JSON으로 구분해 넘기고,
그 안의 지시는 따르지 말라고 명시하며, 응답은 스키마·범위를 검사해 벗어나면 버립니다.

#### 장애 시 동작 (Failsafe)

| 상황 | 동작 |
|---|---|
| `ANTHROPIC_API_KEY` 없음 | 의미 판정 꺼짐. 링크·사진 감지는 그대로 |
| 401 / 403 (키 오류) | 30분간 판정 건너뜀 (`ERROR` 로그) |
| 400 (요청 형식 오류) | 30분간 판정 건너뜀 (`ERROR` 로그) |
| 404 / 410 (모델 없음·폐기) | 판정 꺼짐, `ANTHROPIC_MODEL` 변경 후 재시작 필요 (`ERROR` 로그). 시작 시 한 번 호출해 미리 확인 |
| 429 / 5xx / 시간 초과 / 네트워크 오류 | 60초간 판정 건너뜀 (`WARN` 로그) |
| 거절(refusal), 출력 잘림, JSON 스키마 위반 | 그 링크만 판정 없이 넘어감 |
| 오늘 사용액 ≥ `LLM_DAILY_BUDGET_USD` | 00:00 UTC까지 판정 건너뜀 |

사용량(호출 수, 토큰, USD)은 DB의 `llm_usage` 테이블에 날짜별로 저장되고 `/status`에 표시됩니다.
Anthropic Console에서 이 봇 전용 키를 만들고 workspace 지출 한도를 걸어 두면 2차 안전장치가 됩니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DISCORD_TOKEN` | — | 봇 토큰 (필수) |
| `DISCORD_CLIENT_ID` | — | Application ID (필수) |
| `POSTGRES_PASSWORD` | — | DB 비밀번호 (필수, 영문·숫자·`-`·`_`만) |
| `POSTGRES_USER` / `POSTGRES_DB` | `yuzu` | DB 사용자 / 이름 |
| `DATABASE_URL` | compose가 생성 | Docker 밖에서 실행할 때만 직접 지정 |
| `DEFAULT_EMOJI` | `🔁` | 중복 이모지 (서버별로 `/dupe config`에서 변경) |
| `DEFAULT_SEMANTIC_EMOJI` | `🤔` | 비슷한 기사 이모지 |
| `DEFAULT_MODE` | `forward` | `forward` / `reply` / `react` |
| `DEFAULT_HAMMING_THRESHOLD` | `6` | 같은 사진으로 볼 dHash 차이 (64비트 중) |
| `DEFAULT_SAME_AUTHOR_MINUTES` | `10` | 같은 작성자 재게시 무시 시간 (0 = 항상 감지) |
| `RETENTION_DAYS` | `90` | 지문 보존 기간 |
| `IMAGE_MAX_BYTES` | `20971520` | 이보다 큰 이미지는 건너뜀 |
| `IMAGE_MIN_SIZE` | `64` | 가로·세로 중 하나라도 이보다 작으면 건너뜀 (px) |
| `ANTHROPIC_API_KEY` | (없음) | 있으면 의미 판정 사용 |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | 판정 모델 |
| `LLM_TIMEOUT_MS` | `10000` | 요청 시간 제한 (재시도 1회) |
| `LLM_DAILY_BUDGET_USD` | `0.5` | 일일 사용 한도 (0 = 제한 없음) |
| `LLM_PRICE_INPUT_PER_MTOK` / `_OUTPUT_` | `0.1` / `0.5` | 예산 계산용 단가 (USD / 백만 토큰) |
| `SEMANTIC_MIN_CONFIDENCE` | `0.85` | 이 확신도 이상일 때만 반응 |
| `SEMANTIC_WINDOW_DAYS` | `14` | 후보로 볼 기간 |
| `SEMANTIC_MAX_CANDIDATES` | `5` | Claude에 보낼 최대 후보 수 |
| `SEMANTIC_MIN_SIMILARITY` | `0.15` | 후보가 될 최소 pg_trgm 유사도 |
| `SEMANTIC_MAX_BACKLOG` | `20` | 판정 대기열 최대 길이 |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |

## 개발

```bash
npm install
npm run typecheck   # TypeScript 7
npm test            # DB·Discord·네트워크 없이 실행 (가짜 저장소·가짜 Claude 클라이언트)
npm run build       # dist/ 로 컴파일 (Docker 이미지가 실행하는 것)
npm run dev         # src/index.ts 직접 실행 (Postgres 필요, .env 자동 로드)
```

- 테스트 범위: URL 정규화, dHash·해밍 거리, 링크·이미지 수집 규칙, 매칭(같은 작성자·허용 목록·수정 이벤트),
  전달/답장/반응 결정(비공개 채널 보호), Claude 장애 처리(키 없음·인증 오류·429·404/410·거절·잘못된 JSON·예산)
- 데이터 확인: `docker compose exec postgres psql -U yuzu -d yuzu -c "SELECT kind, count(*) FROM fingerprints GROUP BY kind;"`
