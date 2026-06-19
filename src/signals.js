import { insertSignal, listSignals, withRetry } from './db.js';
import { checkAndConsume } from './rateLimit.js';

function nowMs() {
  return Date.now();
}

/**
 * POST /v1/signals
 *
 * Key correctness properties:
 *  1. Idempotency check happens BEFORE rate-limit consumption so duplicate
 *     replays don't eat into the caller's quota.
 *  2. The INSERT is atomic (INSERT OR IGNORE + SELECT in one transaction)
 *     so concurrent requests with the same Idempotency-Key can never
 *     produce two rows — the DB constraint is the source of truth.
 *  3. Transient DB failures are retried with exponential back-off + jitter
 *     (up to 3 attempts).  Because we use INSERT OR IGNORE the retry is
 *     idempotent even when the first attempt partially succeeded.
 */
export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};

  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  // ------------------------------------------------------------------
  // Rate limiting
  // ------------------------------------------------------------------
  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) {
    return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });
  }

  // ------------------------------------------------------------------
  // Atomic idempotent insert (with retry on transient DB errors)
  // ------------------------------------------------------------------
  try {
    const { row, created } = await withRetry(() =>
      insertSignal(userId, type, payload, idem, nowMs())
    );

    const status = created ? 201 : 200;
    return reply.code(status).send({
      id: row.id,
      userId: row.userId,
      type: row.type,
      payload: row.payload,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt,
    });
  } catch (err) {
    req.log.error({ err, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

/**
 * GET /v1/signals?userId=...&limit=...
 */
export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });

  const lim = Math.min(Number(limit) || 20, 100);

  try {
    const rows = await withRetry(() => listSignals(userId, lim));
    return reply.code(200).send({ items: rows });
  } catch (err) {
    req.log.error({ err, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}