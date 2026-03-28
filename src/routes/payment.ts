import { Router, Request, Response } from 'express';
import { parsePaymentCallback } from '../services/payment.js';
import { handlePaymentConfirmed } from '../handlers/conversation.js';
import { logger } from '../config/logger.js';

export const paymentRouter = Router();

/**
 * POST /webhooks/payment
 * PhonePe payment callback webhook.
 * PhonePe sends a base64-encoded payload with an X-VERIFY checksum header.
 */
paymentRouter.post('/payment', async (req: Request, res: Response) => {
  try {
    const body = req.body as { response: string; 'X-VERIFY'?: string };

    // PhonePe also sends checksum in header
    const checksum = (req.headers['x-verify'] as string) ?? body['X-VERIFY'] ?? '';
    const callbackData = parsePaymentCallback({ response: body.response, 'X-VERIFY': checksum });

    if (!callbackData) {
      logger.warn('Invalid PhonePe callback — checksum mismatch or parse error');
      return res.status(400).json({ error: 'Invalid callback' });
    }

    logger.info('PhonePe payment callback received', {
      merchantTxnId: callbackData.merchantTransactionId,
      status: callbackData.status,
    });

    if (callbackData.status === 'PAYMENT_SUCCESS') {
      // Process asynchronously — don't block the response
      setImmediate(() =>
        handlePaymentConfirmed(
          callbackData.merchantTransactionId,
          callbackData.paymentInstrument?.utr ?? callbackData.transactionId
        ).catch((err) => logger.error('Payment confirmed handler error', { err }))
      );
    }

    return res.status(200).json({ success: true });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Payment webhook error', { error });
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /payment/redirect
 * PhonePe redirect URL after user completes payment in their UPI app.
 * This is shown to the user — send a friendly response.
 */
paymentRouter.post('/redirect', (req: Request, res: Response) => {
  res.status(200).send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>✅ Payment Received!</h2>
        <p>Your recharge is being processed. You'll receive a WhatsApp confirmation shortly.</p>
        <p style="color:#888;font-size:14px">You can close this page.</p>
      </body>
    </html>
  `);
});
