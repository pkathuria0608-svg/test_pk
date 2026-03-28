import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { logger } from './config/logger.js';
import { checkConnection } from './db/index.js';
import { webhookRouter } from './routes/webhook.js';
import { paymentRouter } from './routes/payment.js';

const app = express();

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());

// Parse both JSON and URL-encoded bodies (Gupshup uses form-urlencoded)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'recharge-agent', timestamp: new Date().toISOString() });
});

app.use('/webhooks', webhookRouter);
app.use('/payment', paymentRouter);

// ─── 404 ──────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled express error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await checkConnection();

  app.listen(config.port, () => {
    logger.info(`Recharge Agent running on port ${config.port}`, {
      env: config.nodeEnv,
    });
  });
}

start().catch((err) => {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});
