import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function postStatus(url, { headers = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function postJson(url, { headers = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function spawnServer(port, extraEnv = {}) {
  const proc = spawn('node', ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      API_KEY: 'test-key',
      PORT: String(port),
      DATABASE_URL: `./data/test-rl-${port}.db`,
      LOG_LEVEL: 'silent',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  proc.unref();
  return proc;
}

// ---------------------------------------------------------------------------
// Test: allow N, block N+1
// ---------------------------------------------------------------------------
test('rate limit: allow 5 per minute, 6th is 429', async () => {
  const PORT = 19094;
  const proc = spawnServer(PORT, { RATE_LIMIT_PER_MIN: '5' });
  await wait(500);

  const base = `http://localhost:${PORT}`;
  const statuses = [];

  for (let i = 0; i < 6; i++) {
    const code = await postStatus(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'test-key' },
      body: { userId: 'rl-user', type: 'note', payload: String(i) },
    });
    statuses.push(code);
  }

  const ok429 = statuses.filter((s) => s === 429);
  const ok201 = statuses.filter((s) => s === 201);

  assert.ok(ok201.length >= 5, `Expected >= 5 successes, got: ${ok201.length} — statuses: ${statuses}`);
  assert.ok(ok429.length >= 1, `Expected >= 1 throttle, got: ${ok429.length} — statuses: ${statuses}`);

  proc.kill();
});

// ---------------------------------------------------------------------------
// Test: different users have independent limits
// ---------------------------------------------------------------------------
test('rate limit: different users have independent counters', async () => {
  const PORT = 19095;
  const proc = spawnServer(PORT, { RATE_LIMIT_PER_MIN: '3' });
  await wait(500);

  const base = `http://localhost:${PORT}`;

  // Exhaust userA (3 allowed).
  for (let i = 0; i < 3; i++) {
    await postStatus(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'test-key' },
      body: { userId: 'userA', type: 'x', payload: String(i) },
    });
  }

  // userA should now be throttled.
  const throttled = await postStatus(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'test-key' },
    body: { userId: 'userA', type: 'x', payload: 'overflow' },
  });
  assert.equal(throttled, 429, 'userA should be throttled');

  // userB should still be fine.
  const allowed = await postStatus(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'test-key' },
    body: { userId: 'userB', type: 'x', payload: 'first' },
  });
  assert.equal(allowed, 201, 'userB should not be throttled');

  proc.kill();
});

// ---------------------------------------------------------------------------
// Test: 429 response includes remaining and resetMs headers/body
// ---------------------------------------------------------------------------
test('rate limit: 429 response body includes resetMs', async () => {
  const PORT = 19096;
  const proc = spawnServer(PORT, { RATE_LIMIT_PER_MIN: '1' });
  await wait(500);

  const base = `http://localhost:${PORT}`;
  const headers = { 'x-api-key': 'test-key' };
  const body = { userId: 'rl2', type: 'x', payload: '0' };

  // First call — allowed.
  await postJson(`${base}/v1/signals`, { headers, body });

  // Second call — throttled.
  const res = await postJson(`${base}/v1/signals`, { headers, body });

  assert.equal(res.status, 429);
  assert.ok(typeof res.body.resetMs === 'number', 'resetMs should be a number');
  assert.equal(res.body.remaining, 0);

  proc.kill();
});

// ---------------------------------------------------------------------------
// Test: burst of concurrent requests — no over-counting
// ---------------------------------------------------------------------------
test('rate limit: concurrent burst stays within limit', async () => {
  const PORT = 19097;
  const LIMIT = 5;
  const proc = spawnServer(PORT, { RATE_LIMIT_PER_MIN: String(LIMIT) });
  await wait(500);

  const base = `http://localhost:${PORT}`;

  // Send LIMIT+5 concurrent requests.
  const statuses = await Promise.all(
    Array.from({ length: LIMIT + 5 }, (_, i) =>
      postStatus(`${base}/v1/signals`, {
        headers: { 'x-api-key': 'test-key' },
        body: { userId: 'burst-user', type: 'burst', payload: String(i) },
      })
    )
  );

  const allowed = statuses.filter((s) => s === 201 || s === 200).length;
  const throttled = statuses.filter((s) => s === 429).length;

  // We allow a small over-count tolerance because Node.js is single-threaded
  // and the in-process limiter is synchronous — in practice it should be exact.
  assert.ok(
    allowed <= LIMIT,
    `Too many allowed: ${allowed} (limit=${LIMIT}). statuses: ${statuses}`
  );
  assert.ok(throttled >= 5, `Expected >= 5 throttled, got ${throttled}`);

  proc.kill();
});