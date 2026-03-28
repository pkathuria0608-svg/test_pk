import { Router, Request, Response } from 'express';
import { handleMessage } from '../handlers/conversation.js';
import { logger } from '../config/logger.js';
import type { GupshupMessage } from '../types/index.js';

export const webhookRouter = Router();

/**
 * POST /webhooks/whatsapp
 * Gupshup inbound message webhook.
 */
webhookRouter.post('/whatsapp', async (req: Request, res: Response) => {
  // Acknowledge immediately — Gupshup requires a fast 200 response
  res.status(200).json({ status: 'ok' });

  try {
    const body = req.body;

    // Gupshup sends either form-urlencoded or JSON
    const payload = typeof body === 'string' ? JSON.parse(body) : body;

    // Handle both single message and array of messages
    const messages: GupshupMessage[] = Array.isArray(payload) ? payload : [payload];

    for (const msg of messages) {
      if (msg.type !== 'message') continue;
      await handleMessage(msg);
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Webhook processing error', { error, body: req.body });
  }
});
