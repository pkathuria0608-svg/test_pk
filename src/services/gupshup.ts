import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const GUPSHUP_API = 'https://media.smsgupshup.com/GatewayAPI/rest';

/**
 * Build the common auth + routing params required by the Gupshup REST gateway.
 */
function baseParams(to: string): Record<string, string> {
  return {
    userid: config.gupshup.userId,
    password: config.gupshup.password,
    send_to: normalizePhone(to),
    auth_scheme: 'plain',
    method: 'SendMessage',
    v: '1.1',
    format: 'json',
  };
}

/**
 * Send a plain text message via Gupshup SMS/WhatsApp REST gateway.
 */
export async function sendText(to: string, text: string): Promise<void> {
  const phone = normalizePhone(to);
  try {
    const params = new URLSearchParams({
      ...baseParams(to),
      msg_type: 'DATA_TEXT',
      msg: text,
    });

    const response = await axios.post(GUPSHUP_API, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    logger.debug('Sent message via Gupshup', {
      to: phone,
      preview: text.slice(0, 50),
      response: response.data,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Gupshup send error', { error: msg, to: phone });
  }
}

/**
 * Send a list of quick-reply buttons.
 * The Gupshup REST gateway does not support interactive buttons natively,
 * so this falls back to a numbered plain-text list.
 */
export async function sendButtons(
  to: string,
  body: string,
  buttons: { id: string; title: string }[]
): Promise<void> {
  const fallback = body + '\n\n' + buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
  await sendText(to, fallback);
}

function normalizePhone(phone: string): string {
  // Strip +, spaces, dashes. Add 91 prefix for Indian numbers if missing.
  const clean = phone.replace(/[+\s\-]/g, '');
  if (clean.length === 10) return `91${clean}`;
  return clean;
}
