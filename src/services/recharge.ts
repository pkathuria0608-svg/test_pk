import axios from 'axios';
import crypto from 'crypto';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import type { RechargeRequest, RechargeResponse, Operator } from '../types/index.js';

// Maps our operator codes to PaySprint operator IDs
const PAYSPRINT_OPERATOR_MAP: Record<Operator, string> = {
  JIO: 'JIO',
  AIRTEL: 'AIRTEL',
  VI: 'VI',
  BSNL: 'BSNL',
  MTNL: 'MTNL',
};

function buildAuthHeader(): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const token = crypto
    .createHmac('sha256', config.paysprint.apiKey)
    .update(config.paysprint.memberId + timestamp)
    .digest('hex');
  return `Bearer ${token}`;
}

/**
 * Execute a prepaid mobile recharge via PaySprint API.
 */
export async function executeRecharge(req: RechargeRequest): Promise<RechargeResponse> {
  const operatorCode = PAYSPRINT_OPERATOR_MAP[req.operator as Operator] ?? req.operator;

  const payload = {
    operator: operatorCode,
    canumber: req.mobile,
    amount: req.amount.toString(),
    referenceid: req.transactionId,
    latitude: '0',
    longitude: '0',
  };

  logger.info('Executing recharge via PaySprint', {
    mobile: req.mobile,
    operator: operatorCode,
    amount: req.amount,
    txnId: req.transactionId,
  });

  try {
    const response = await axios.post(
      `${config.paysprint.baseUrl}/recharge/dorecharge`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: buildAuthHeader(),
          'Member-Id': config.paysprint.memberId,
        },
        timeout: 30000,
      }
    );

    const data = response.data;

    if (data.status === true || data.response_code === 1) {
      logger.info('Recharge successful', { operatorRef: data.operatorid, txnId: req.transactionId });
      return {
        success: true,
        operatorRef: data.operatorid ?? data.txnid,
        message: data.message ?? 'Recharge successful',
      };
    }

    logger.warn('Recharge failed', { response: data, txnId: req.transactionId });
    return {
      success: false,
      message: data.message ?? 'Recharge failed. Please try again.',
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('PaySprint API error', { error: msg, txnId: req.transactionId });
    return { success: false, message: 'Recharge service temporarily unavailable.' };
  }
}

/**
 * Check the status of a previously submitted recharge.
 */
export async function checkRechargeStatus(transactionId: string): Promise<RechargeResponse> {
  try {
    const response = await axios.post(
      `${config.paysprint.baseUrl}/recharge/reportstatus`,
      { referenceid: transactionId },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: buildAuthHeader(),
          'Member-Id': config.paysprint.memberId,
        },
        timeout: 15000,
      }
    );

    const data = response.data;
    const success = data.status === true || data.txnstatus === 'SUCCESS';
    return {
      success,
      operatorRef: data.operatorid,
      message: data.message ?? (success ? 'Recharge successful' : 'Recharge failed'),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('PaySprint status check error', { error: msg, transactionId });
    return { success: false, message: 'Unable to check status. Please contact support.' };
  }
}

/**
 * Auto-detect operator from a mobile number via PaySprint operator lookup.
 */
export async function detectOperator(mobile: string): Promise<{ operator: Operator; circle: string } | null> {
  try {
    const response = await axios.post(
      `${config.paysprint.baseUrl}/recharge/getoperator`,
      { mobile },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: buildAuthHeader(),
          'Member-Id': config.paysprint.memberId,
        },
        timeout: 10000,
      }
    );

    const data = response.data;
    if (data.status === true && data.operator) {
      return {
        operator: data.operator.toUpperCase() as Operator,
        circle: data.circle ?? 'Unknown',
      };
    }
    return null;
  } catch {
    return null;
  }
}
