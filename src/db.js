import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// WAL mode: better concurrent read throughput and crash safety.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

// Schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  idempotency_key TEXT    UNIQUE,          -- DB-level uniqueness guarantee
  created_at      INTEGER NOT NULL
);

-- Fast lookups for GET /v1/signals?userId=...
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);

-- Fast idempotency lookups (covering index avoids table scan)
CREATE INDEX IF NOT EXISTS idx_idem_key ON signals(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`);

// ---------------------------------------------------------------------------
// Failure simulation
// ---------------------------------------------------------------------------
function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retry / back-off helper
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 50;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Runs `fn` up to MAX_ATTEMPTS times, with exponential back-off + jitter.
 * Only retries on transient DB errors (SQLITE_BUSY, SQLITE_LOCKED, simulated).
 */
export async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (err) {
      const transient =
        err.code === 'SQLITE_BUSY' ||
        err.code === 'SQLITE_LOCKED' ||
        err.message === 'simulated_db_failure';
      if (!transient) throw err;          // surface schema errors, etc. immediately
      lastErr = err;
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * BASE_DELAY_MS;
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

/**
 * Atomic idempotent insert.
 *
 * Uses INSERT OR IGNORE so that a duplicate idempotency_key is silently
 * dropped at the DB level — no check-then-insert race possible.
 * After the attempt, SELECT returns whichever row owns the key.
 *
 * Returns { row, created } where created=false means a duplicate was found.
 */
const stmtInsertOrIgnore = db.prepare(
  `INSERT OR IGNORE INTO signals (user_id, type, payload, idempotency_key, created_at)
   VALUES (?, ?, ?, ?, ?)`
);

const stmtFetchByIdem = db.prepare(
  `SELECT id,
          user_id         AS userId,
          type,
          payload,
          idempotency_key AS idempotencyKey,
          created_at      AS createdAt
   FROM   signals
   WHERE  idempotency_key = ?`
);

const stmtInsert = db.prepare(
  `INSERT INTO signals (user_id, type, payload, idempotency_key, created_at)
   VALUES (?, ?, ?, ?, ?)`
);

// Wrapped in a transaction so the INSERT + SELECT are one atomic unit.
const insertIdempotent = db.transaction((userId, type, payload, idemKey, nowMs) => {
  const info = stmtInsertOrIgnore.run(userId, type, String(payload), idemKey, nowMs);
  const row  = stmtFetchByIdem.get(idemKey);
  return { row, created: info.changes === 1 };
});

export function insertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();

  if (idemKey) {
    // Idempotent path — atomic INSERT OR IGNORE + SELECT in one transaction.
    return insertIdempotent(userId, type, String(payload), idemKey, nowMs);
  }

  // No idempotency key — plain insert.
  const info = stmtInsert.run(userId, type, String(payload), null, nowMs);
  const row = {
    id: info.lastInsertRowid,
    userId,
    type,
    payload: String(payload),
    idempotencyKey: null,
    createdAt: nowMs,
  };
  return { row, created: true };
}

export function listSignals(userId, limit) {
  maybeFail();
  return db
    .prepare(
      `SELECT id,
              user_id         AS userId,
              type,
              payload,
              idempotency_key AS idempotencyKey,
              created_at      AS createdAt
       FROM   signals
       WHERE  user_id = ?
       ORDER  BY created_at DESC
       LIMIT  ?`
    )
    .all(userId, limit);
}