import Fastify from 'fastify';
import dotenv from 'dotenv';
import { postSignal, getSignals } from './signals.js';

dotenv.config();

const API_KEY = process.env.API_KEY || 'change-me';
const PORT    = Number(process.env.PORT || 8080);
const HOST    = process.env.HOST || '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    // Use pino-pretty in dev; structured JSON in prod.
    ...(process.env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty' } }
      : {}),
  },
});

// ---------------------------------------------------------------------------
// Auth hook — runs on every request except /healthz
// ---------------------------------------------------------------------------
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/healthz') return;
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/healthz', async (_req, _reply) => ({ ok: true, ts: Date.now() }));
app.post('/v1/signals', postSignal);
app.get('/v1/signals',  getSignals);

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
app.setNotFoundHandler((_req, reply) => {
  reply.code(404).send({ error: 'not_found' });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}