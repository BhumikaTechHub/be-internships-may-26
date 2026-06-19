# Signals Challenge (Node.js + Fastify)

A minimal production-leaning signals ingestion service with robust rate limiting, atomic idempotency, and retry/back-off on DB failures.

---

## Quick start

```bash
cp .env.example .env        # edit API_KEY, DATABASE_URL, etc.
npm install
npm run dev                 # starts on PORT (default 8080)
```

### Run tests

```bash
npm test
```

### Benchmark

```bash
npm run dev &
npm run bench
```

---

## Endpoints

### `POST /v1/signals`

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-API-Key` | ✅ | Shared secret from `API_KEY` env var |
| `Idempotency-Key` | ❌ | Arbitrary string; same key → same response |

**Body**

```json
{ "userId": "string", "type": "string", "payload": "string" }
```

**Responses**

| Status | Meaning |
|---|---|
| 201 | Signal created |
| 200 | Duplicate — returned existing record (idempotency hit) |
| 400 | Missing / invalid body fields |
| 401 | Bad or missing `X-API-Key` |
| 429 | Rate limited (`RATE_LIMIT_PER_MIN` exceeded for this `userId`) |
| 503 | DB unavailable after retries |

**Behaviour**
- Rate-limited per `userId`: `RATE_LIMIT_PER_MIN` requests per 60-second sliding window (default 5).
- Idempotent: concurrent or repeated requests with the same `Idempotency-Key` produce exactly one DB row and always return the same response body.

---

### `GET /v1/signals?userId=...&limit=...`

Returns up to `limit` (max 100, default 20) most recent signals for the given `userId`.

---

### `GET /healthz`

Returns `{ "ok": true, "ts": <epoch_ms> }`. No auth required.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | `change-me` | Shared secret for `X-API-Key` header |
| `PORT` | `8080` | TCP port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | `./data/signals.db` | SQLite file path |
| `RATE_LIMIT_PER_MIN` | `5` | Max requests per `userId` per minute |
| `DB_FAIL_RATE` | `0` | Fraction of DB calls to simulate failing (0–1) |
| `LOG_LEVEL` | `info` | Pino log level (`silent`, `info`, `debug`, …) |

---

## Design decisions

### Atomic idempotency

`INSERT OR IGNORE INTO signals … RETURNING *` wrapped in a SQLite transaction gives us an atomic "upsert-and-read" with no check-then-insert race.  The `UNIQUE(idempotency_key)` DB constraint is the single source of truth — even if two concurrent requests arrive at the same millisecond, only one row is ever created.

### True sliding-window rate limiter

Each `userId` gets an in-memory array of request timestamps.  On every call we:
1. Evict timestamps older than 60 s.
2. Append the current timestamp.
3. Compare the count to `RATE_LIMIT_PER_MIN`.

This avoids the "boundary burst" problem of fixed-window counters.

### Retry with jitter

Transient DB errors (`SQLITE_BUSY`, `SQLITE_LOCKED`, simulated failures) are retried up to 3 times with exponential back-off + random jitter starting at 50 ms.  Because the insert is idempotent the retry cannot create duplicates.

### Multi-instance scaling

See **SCALE.md** for a full plan.  In summary:
- Idempotency: move to a PostgreSQL `ON CONFLICT DO NOTHING` upsert — the DB constraint works across all pods.
- Rate limiting: replace the in-memory map with a Redis sorted-set Lua script.

---

## Project structure

```
.
├── src/
│   ├── server.js      — Fastify server, auth hook, graceful shutdown
│   ├── signals.js     — Route handlers (postSignal, getSignals)
│   ├── rateLimit.js   — Sliding-window rate limiter
│   └── db.js          — SQLite schema, atomic upsert, retry helper
├── tests/
│   ├── idempotency.test.js
│   └── rate-limit.test.js
├── SCALE.md
├── .env.example
└── package.json
```