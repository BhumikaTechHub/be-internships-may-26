/**
 * In-process sliding-window rate limiter.
 *
 * Uses a per-user array of request timestamps (ms).  On each call we:
 *   1. Drop timestamps older than WINDOW_MS.
 *   2. Append the current timestamp.
 *   3. Allow if the resulting count <= RATE.
 *
 * This is a true sliding window — no "bucket resets every N seconds" drift.
 *
 * Multi-instance note (see SCALE.md):
 *   For a single process this is correct.  For horizontal scale, replace the
 *   in-memory Map with a Redis ZADD/ZRANGEBYSCORE pipeline (atomic via Lua or
 *   a single MULTI/EXEC block) so all pods share the same counter.
 */

const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

// userId → Int32Array-backed ring (we use plain arrays for simplicity; swap
// for a circular buffer if memory matters at scale).
const windows = new Map();

export function checkAndConsume(userId, nowMs = Date.now()) {
  const cutoff = nowMs - WINDOW_MS;

  let timestamps = windows.get(userId);
  if (!timestamps) {
    timestamps = [];
    windows.set(userId, timestamps);
  }

  // Evict expired entries (they are always at the front because we append in order).
  let start = 0;
  while (start < timestamps.length && timestamps[start] <= cutoff) start++;
  if (start > 0) timestamps.splice(0, start);

  // Append current request.
  timestamps.push(nowMs);

  const count = timestamps.length;
  const ok = count <= RATE;
  const remaining = Math.max(RATE - count, 0);
  // Reset time = when the oldest request in the window will expire.
  const resetMs = timestamps[0] + WINDOW_MS;

  return { ok, remaining, resetMs };
}

/**
 * Exposed for testing only — lets tests reset state between runs.
 */
export function _resetAll() {
  windows.clear();
}