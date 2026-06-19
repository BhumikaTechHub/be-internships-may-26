# Scale Plan — Signals Service (10 k RPS target)

## 1. Data model / indexes

| Index | Purpose |
|---|---|
| `PRIMARY KEY` on `id` | Point lookups by record id |
| `UNIQUE(idempotency_key)` | DB-enforced deduplication — the constraint *is* the idempotency guarantee |
| `idx_user_created (user_id, created_at DESC)` | Covering index for `GET /v1/signals?userId=` — avoids full table scan |
| `idx_idem_key` (partial, `WHERE idempotency_key IS NOT NULL`) | Smaller index, faster idempotency lookups |

**Beyond SQLite** — at 10 k RPS SQLite becomes a bottleneck because it serialises writes.  
Migrate to **PostgreSQL 16** (or CockroachDB for geo-distributed):
- Use `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` — single round-trip atomic upsert.
- Connection pool via **PgBouncer** (transaction mode, 20–50 connections per pod).
- Partition `signals` by `created_at` (monthly ranges) to keep hot data small.
- Archive old partitions to S3/Parquet for analytics.

---

## 2. Idempotency across instances

**Current (single process):** `INSERT OR IGNORE` + `SELECT` inside one SQLite transaction.  
Works correctly for any number of concurrent requests within one process.

**Multi-instance / multi-pod:**  
The idempotency guarantee must move to the shared DB layer — not in-memory.

```
Client → Load Balancer → Pod A │
                         Pod B ├─→ PostgreSQL (UNIQUE constraint)
                         Pod C │
```

- Every pod runs `INSERT … ON CONFLICT DO NOTHING RETURNING *`.  
  The DB unique constraint guarantees exactly-once write regardless of which pod receives the request.
- No distributed lock needed — `ON CONFLICT` is atomic at the storage layer.
- For **cross-region** deployments, use a **Redis** or **DynamoDB** idempotency store with a TTL (e.g. 24 h) as the primary dedup layer, and write to the regional DB only on first occurrence.

---

## 3. Rate limiting across instances

**Current (single process):** in-memory sliding-window per `userId`.  
**Breaks** when multiple pods run — each pod has its own counter.

**Multi-pod fix: Redis sliding window (Lua script)**

```lua
-- KEYS[1] = "rl:{userId}"  ARGV[1] = nowMs  ARGV[2] = windowMs  ARGV[3] = limit
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local cutoff = now - window

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZADD', key, 'NX', now, now)   -- add current ts
local total = redis.call('ZCARD', key)
redis.call('PEXPIRE', key, window)
return { total, total <= limit and 1 or 0 }
```

- Single Lua script = atomic — no race between ZADD and ZCARD.
- Use **Redis Cluster** (6 nodes, 3 primary + 3 replica) for HA.
- Fallback: if Redis is unreachable, fail-open (allow the request) and log a warning — better than a cascading 429 storm.

---

## 4. Observability

| Signal | Tool | Alert threshold |
|---|---|---|
| Request rate (RPS) | Prometheus `http_requests_total` | > 12 k RPS (warn), > 15 k (page) |
| P99 latency | Histogram `http_request_duration_ms` | > 200 ms |
| Error rate | Counter `http_errors_total{code=5xx}` | > 0.1 % |
| DB pool saturation | `pg_pool_waiting_count` | > 0 for > 5 s |
| Rate-limit hit rate | Counter `rate_limit_rejected_total` | > 20 % of traffic |
| Idempotency hit rate | Counter `idempotency_hit_total` | — (informational) |
| Redis latency | `redis_command_duration_ms` | > 10 ms P99 |

**Structured logging:** every request logs `{traceId, userId, method, path, status, durationMs}` as JSON → Loki / CloudWatch Logs.  
**Distributed tracing:** OpenTelemetry SDK → Jaeger or Tempo.

---

## 5. Failure modes

| Failure | Behaviour | Recovery |
|---|---|---|
| DB transient busy | Retry × 3 with exponential back-off + jitter (50 ms base) | Automatic |
| DB down (sustained) | Return 503 after retries exhausted | Circuit breaker opens; operator alert |
| Redis down (rate limiter) | Fail-open: allow requests, log warning | Circuit breaker; fall back to per-pod in-memory limiter |
| Pod crash mid-insert | `INSERT OR IGNORE` is idempotent; client retries with same key → same result | No duplicate |
| Network partition (client ↔ LB) | Client timeout → retry with same `Idempotency-Key` | Safe; DB constraint deduplicates |
| Runaway user (no rate limit Redis) | Per-pod in-memory fallback still limits to `RATE_LIMIT_PER_MIN` per pod | Partial protection |

**Circuit breaker** (e.g. `opossum` library):  
- Open after 5 consecutive DB errors in 10 s.  
- Half-open probe every 5 s.  
- Returns 503 while open.

---

## 6. 10 k RPS design sketch

### Traffic profile
- `POST /v1/signals`: ~80 % of traffic, write-heavy.
- `GET /v1/signals`: ~20 %, read-heavy.

### Infra layout

```
             ┌─────────────────────────────────────────────────────┐
             │                  CDN / WAF                          │
             └───────────────────────┬─────────────────────────────┘
                                     │
             ┌───────────────────────▼─────────────────────────────┐
             │         Layer-7 Load Balancer (NGINX / ALB)         │
             │         Keep-alive, HTTP/2, TLS termination          │
             └──────────┬────────────────────┬────────────────────-┘
                        │                    │
              ┌─────────▼──────┐   ┌─────────▼──────┐
              │  API Pod × N   │   │  API Pod × N   │  (Kubernetes, HPA)
              │  Node 22 LTS   │   │  Node 22 LTS   │
              │  4 vCPU / 1 GB │   │  4 vCPU / 1 GB │
              └────────┬───────┘   └────────┬───────┘
                       │                    │
         ┌─────────────▼────────────────────▼──────────┐
         │        Redis Cluster (rate limiter)          │
         │        3 primary + 3 replica, 8 GB each      │
         └──────────────────────┬───────────────────────┘
                                │
         ┌──────────────────────▼───────────────────────┐
         │   PostgreSQL primary + 2 read replicas        │
         │   PgBouncer sidecar per pod (pool size 20)    │
         │   64 vCPU, 256 GB RAM, NVMe SSD               │
         └──────────────────────────────────────────────-┘
```

### Sizing

| Component | Count | vCPU | RAM | Monthly cost (AWS) |
|---|---|---|---|---|
| API pods (HPA 2–20) | avg 8 | 4 | 1 GB | ~$400 |
| Redis cluster | 6 nodes | 2 | 8 GB | ~$600 |
| PostgreSQL primary | 1 | 64 | 256 GB | ~$3 500 |
| PostgreSQL replicas | 2 | 16 | 64 GB | ~$1 400 |
| ALB + data transfer | — | — | — | ~$300 |
| **Total** | | | | **~$6 200 / mo** |

### Write path optimisation
1. **Batching:** accumulate signals in a bounded in-memory queue (max 10 ms or 500 items), flush with a single `INSERT … VALUES (…),(…),…`.  Throughput ×10–20, latency +10 ms.
2. **Async write queue:** for non-idempotent signals, push to Kafka → consumer inserts to DB.  Decouples ingestion from storage.  Add idempotency store (Redis TTL set) at the Kafka producer level.
3. **Idempotency TTL:** prune `idempotency_key` older than 24 h via a nightly job to keep the unique index lean.

### Read path optimisation
1. **Read replicas:** `GET /v1/signals` queries route to replicas.
2. **Application cache:** short TTL (1 s) in Redis for hot `userId` list queries.
3. **Pagination cursor:** replace `OFFSET` with `WHERE created_at < :cursor` for stable, index-friendly pagination.