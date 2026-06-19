import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') });
          } catch {
            resolve({ status: res.statusCode, body: chunks });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function spawnServer(port, extraEnv = {}) {
  const proc = spawn(
    'node',
    ['src/server.js'],
    {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        API_KEY: 'test-key',
        PORT: String(port),
        DATABASE_URL: `./data/test-idem-${port}.db`,
        LOG_LEVEL: 'silent',
        ...extraEnv,
      },
      stdio: 'ignore',
    }
  );
  proc.unref();
  return proc;
}

// ---------------------------------------------------------------------------
// Test: same Idempotency-Key returns same resource
// ---------------------------------------------------------------------------
test('idempotency: same key returns same resource', async () => {
  const PORT = 19091;
  const proc = spawnServer(PORT);
  await wait(500); // give the server time to bind

  const base = `http://localhost:${PORT}`;
  const idem = `idem-${Date.now()}`;

  const a = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'test-key', 'idempotency-key': idem },
    body: { userId: 'u1', type: 'note', payload: 'hello' },
  });
  const b = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'test-key', 'idempotency-key': idem },
    body: { userId: 'u1', type: 'note', payload: 'hello' },
  });

  // First call → 201 Created; second call → 200 OK (duplicate detected).
  assert.equal(a.status, 201, `expected 201 on first call, got ${a.status}`);
  assert.equal(b.status, 200, `expected 200 on duplicate, got ${b.status}`);

  // Both must return the same record.
  assert.equal(a.body.id, b.body.id, 'ids should match');
  assert.equal(a.body.idempotencyKey, b.body.idempotencyKey, 'idempotency keys should match');
  assert.equal(a.body.idempotencyKey, idem);

  proc.kill();
});

// ---------------------------------------------------------------------------
// Test: concurrent requests with same key produce exactly one record
// ---------------------------------------------------------------------------
test('idempotency: concurrent duplicate requests produce one record', async () => {
  const PORT = 19092;
  const proc = spawnServer(PORT, { RATE_LIMIT_PER_MIN: '100' });
  await wait(500);

  const base = `http://localhost:${PORT}`;
  const idem = `concurrent-${Date.now()}`;

  // Fire 5 concurrent requests with the same key.
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      postJson(`${base}/v1/signals`, {
        headers: { 'x-api-key': 'test-key', 'idempotency-key': idem },
        body: { userId: 'u2', type: 'click', payload: 'btn' },
      })
    )
  );

  // All responses must share the same id.
  const ids = results.map((r) => r.body.id);
  assert.ok(ids.every((id) => id === ids[0]), `Expected all ids to match, got: ${ids}`);

  // Exactly one 201, the rest 200.
  const statuses = results.map((r) => r.status);
  const created = statuses.filter((s) => s === 201).length;
  assert.equal(created, 1, `Expected exactly 1 creation, got ${created}`);

  proc.kill();
});

// ---------------------------------------------------------------------------
// Test: no Idempotency-Key creates separate records
// ---------------------------------------------------------------------------
test('idempotency: no key creates distinct records', async () => {
  const PORT = 19093;
  const proc = spawnServer(PORT, { RATE_LIMIT_PER_MIN: '100' });
  await wait(500);

  const base = `http://localhost:${PORT}`;

  const a = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'test-key' },
    body: { userId: 'u3', type: 'ping', payload: '1' },
  });
  const b = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'test-key' },
    body: { userId: 'u3', type: 'ping', payload: '2' },
  });

  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.id, b.body.id, 'distinct inserts must produce distinct ids');

  proc.kill();
});