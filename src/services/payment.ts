import axios from 'axios';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import type { PaymentOrder, PaymentCallback } from '../types/index.js';

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Build a PhonePe checksum for request authentication.
 * PhonePe formula: SHA256(base64Payload + "/pg/v1/pay" + saltKey) + "###" + saltIndex
 */
function buildChecksum(base64Payload: string, endpoint: string): string {
  const hash = sha256(base64Payload + endpoint + config.phonepe.saltKey);
  return `${hash}###${config.phonepe.saltIndex}`;
}

/**
 * Verify PhonePe callback checksum.
 * Formula: SHA256(base64Payload + saltKey) + "###" + saltIndex
 */
export function verifyCallbackChecksum(base64Payload: string, receivedChecksum: string): boolean {
  const expected = sha256(base64Payload + config.phonepe.saltKey) + `###${config.phonepe.saltIndex}`;
  return expected === receivedChecksum;
}

/**
 * Create a UPI payment order via PhonePe.
 * Returns a payment link the user opens in their UPI app (UPI Intent flow).
 */
export async function createPaymentOrder(
  transactionId: string,
  amountRupees: number,
  mobileNumber: string
): Promise<PaymentOrder> {
  const merchantTransactionId = `RCHG_${transactionId.replace(/-/g, '').slice(0, 20)}`;
  const amountPaise = amountRupees * 100;

  const payload = {
    merchantId: config.phonepe.merchantId,
    merchantTransactionId,
    merchantUserId: `USER_${mobileNumber}`,
    amount: amountPaise,
    redirectUrl: `${config.phonepe.redirectUrl}?txnId=${transactionId}`,
    redirectMode: 'POST',
    callbackUrl: config.phonepe.callbackUrl,
    mobileNumber,
    paymentInstrument: {
      type: 'PAY_PAGE',  // Shows all UPI apps — best for WhatsApp flow
    },
  };

  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const checksum = buildChecksum(base64Payload, '/pg/v1/pay');

  logger.info('Creating PhonePe payment order', {
    transactionId,
    merchantTransactionId,
    amount: amountRupees,
  });

  try {
    const response = await axios.post(
      `${config.phonepe.baseUrl}/pg/v1/pay`,
      { request: base64Payload },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum,
          'X-MERCHANT-ID': config.phonepe.merchantId,
        },
        timeout: 15000,
      }
    );

    const data = response.data;

    if (!data.success) {
      logger.error('PhonePe order creation failed', { response: data, transactionId });
      throw new Error(data.message ?? 'Payment order creation failed');
    }

    const payPageUrl: string =
      data.data?.instrumentResponse?.redirectInfo?.url ?? '';

    logger.info('PhonePe payment order created', { merchantTransactionId, transactionId });

    return {
      orderId: merchantTransactionId,
      transactionId,
      amount: amountRupees,
      upiLink: payPageUrl,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min expiry
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('PhonePe API error', { error: msg, transactionId });
    throw new Error('Payment service temporarily unavailable. Please try again.');
  }
}

/**
 * Check the status of an existing payment order.
 */
export async function checkPaymentStatus(merchantTransactionId: string): Promise<{
  paid: boolean;
  status: string;
  utr?: string;
}> {
  const endpoint = `/pg/v1/status/${config.phonepe.merchantId}/${merchantTransactionId}`;
  const checksum = sha256(`${endpoint}${config.phonepe.saltKey}`) + `###${config.phonepe.saltIndex}`;

  try {
    const response = await axios.get(
      `${config.phonepe.baseUrl}${endpoint}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum,
          'X-MERCHANT-ID': config.phonepe.merchantId,
        },
        timeout: 15000,
      }
    );

    const data = response.data;
    const paid = data.success === true && data.data?.state === 'COMPLETED';
    return {
      paid,
      status: data.data?.state ?? 'UNKNOWN',
      utr: data.data?.paymentInstrument?.utr,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('PhonePe status check error', { error: msg, merchantTransactionId });
    return { paid: false, status: 'ERROR' };
  }
}

/**
 * Parse and validate a PhonePe webhook callback.
 */
export function parsePaymentCallback(body: {
  response: string;
  'X-VERIFY'?: string;
}): PaymentCallback | null {
  try {
    const { response: base64Payload } = body;
    const checksum = body['X-VERIFY'] ?? '';

    if (!verifyCallbackChecksum(base64Payload, checksum)) {
      logger.warn('PhonePe callback checksum mismatch');
      return null;
    }

    const decoded = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf-8'));
    return {
      merchantTransactionId: decoded.data?.merchantTransactionId ?? '',
      transactionId: decoded.data?.transactionId ?? '',
      amount: decoded.data?.amount ?? 0,
      status: decoded.code === 'PAYMENT_SUCCESS' ? 'PAYMENT_SUCCESS' : 'PAYMENT_ERROR',
      paymentInstrument: decoded.data?.paymentInstrument,
    };
  } catch (err: unknown) {
    logger.error('Failed to parse PhonePe callback', { error: err });
    return null;
  }
}

// Re-export uuidv4 usage suppression
void uuidv4;
