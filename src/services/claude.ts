import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import type { ParsedIntent, Operator } from '../types/index.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM_PROMPT = `You are a mobile recharge assistant for India. Extract intent and entities from user messages.

Always respond with valid JSON matching exactly this structure:
{
  "intent": "recharge" | "show_plans" | "check_balance" | "transaction_history" | "help" | "unknown",
  "mobile": "10-digit number or null",
  "operator": "JIO" | "AIRTEL" | "VI" | "BSNL" | "MTNL" | null,
  "amount": number or null,
  "circle": "state/circle name or null"
}

Rules:
- Mobile numbers: extract 10-digit Indian mobile numbers (starting with 6-9). Strip +91 or 0 prefix.
- Operators: map variations — "reliance jio"→"JIO", "vodafone"/"idea"/"voda"/"vi"/"voda idea"→"VI", "airtel"/"bharti"→"AIRTEL", "bsnl"/"government"→"BSNL"
- "recharge" intent: user wants to do a recharge now
- "show_plans" intent: user wants to browse or see plans
- Handle Hindi/Hinglish: "recharge karo", "plan dikhao", "balance check karo"
- If a number mentioned is clearly a plan amount (e.g. "₹199 plan"), set amount not mobile
- For plan selection responses like "1", "2", "3" or "option 1" — set intent as "recharge" with amount as the plan index`;

/**
 * Parse a WhatsApp message to extract recharge intent using Claude.
 * Uses claude-opus-4-6 with adaptive thinking for accurate NLU.
 */
export async function parseIntent(message: string, conversationContext?: string): Promise<ParsedIntent> {
  const userContent = conversationContext
    ? `Previous context: ${conversationContext}\n\nUser message: "${message}"`
    : `User message: "${message}"`;

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinking: { type: 'adaptive' } as any,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text block in response');
    }

    // Strip markdown code fences if present
    const raw = textBlock.text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(raw) as {
      intent: ParsedIntent['intent'];
      mobile?: string;
      operator?: string;
      amount?: number;
      circle?: string;
    };

    logger.debug('Claude NLU result', { message, intent: parsed.intent });

    return {
      intent: parsed.intent ?? 'unknown',
      mobile: parsed.mobile ?? undefined,
      operator: parsed.operator as Operator | undefined,
      amount: parsed.amount ?? undefined,
      circle: parsed.circle ?? undefined,
      rawText: message,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Claude NLU error', { error: msg, message });
    return { intent: 'unknown', rawText: message };
  }
}

/**
 * Generate a conversational response for edge cases / help messages.
 */
export async function generateHelpResponse(userMessage: string): Promise<string> {
  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 300,
      system: `You are a friendly mobile recharge assistant for India.
Keep replies very short (2-3 lines max), conversational, and suitable for WhatsApp.
You can help users: recharge prepaid mobiles (Jio, Airtel, Vi, BSNL), see operator plans, check wallet balance, and view transaction history.
If user asks something unrelated, politely redirect to recharge services.`,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock?.type === 'text' ? textBlock.text : 'How can I help you? Type "recharge" to get started!';
  } catch {
    return 'How can I help you? Type "recharge" to get started!';
  }
}
