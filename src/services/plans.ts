import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { query, queryOne } from '../db/index.js';
import type { RechargePlan, Operator } from '../types/index.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch live plans from Komparify and upsert into local cache.
 */
async function fetchAndCachePlans(operator: Operator, circle: string): Promise<RechargePlan[]> {
  try {
    const response = await axios.get(`${config.komparify.baseUrl}/plans`, {
      params: {
        operator,
        circle,
        type: 'prepaid',
        apikey: config.komparify.apiKey,
      },
      timeout: 15000,
    });

    const rawPlans: Array<{
      amount?: number;
      price?: number;
      validity?: string;
      data?: string;
      talktime?: string;
      sms?: string;
      desc?: string;
      description?: string;
    }> = response.data?.plans ?? response.data ?? [];

    if (!Array.isArray(rawPlans) || rawPlans.length === 0) {
      logger.warn('No plans returned from Komparify', { operator, circle });
      return [];
    }

    // Upsert into cache
    for (const p of rawPlans) {
      const price = p.amount ?? p.price ?? 0;
      if (!price) continue;
      await query(
        `INSERT INTO operator_plans (operator, circle, price, validity, data, calls, sms, description, plan_type, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'prepaid', NOW())
         ON CONFLICT (operator, circle, price, plan_type)
         DO UPDATE SET validity=$4, data=$5, calls=$6, sms=$7, description=$8, fetched_at=NOW()`,
        [operator, circle, price, p.validity ?? '', p.data ?? '', p.talktime ?? '', p.sms ?? '', p.desc ?? p.description ?? '']
      );
    }

    logger.info('Cached plans from Komparify', { operator, circle, count: rawPlans.length });
    return await getPlansFromCache(operator, circle);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch plans from Komparify', { error: msg, operator, circle });
    return await getPlansFromCache(operator, circle); // fall back to stale cache
  }
}

async function getPlansFromCache(operator: Operator, circle: string): Promise<RechargePlan[]> {
  const rows = await query<{
    id: string;
    operator: string;
    circle: string;
    price: number;
    validity: string;
    data: string;
    calls: string;
    sms: string;
    description: string;
    plan_type: string;
  }>(
    `SELECT id, operator, circle, price, validity, data, calls, sms, description, plan_type
     FROM operator_plans
     WHERE operator = $1 AND circle = $2 AND plan_type = 'prepaid'
     ORDER BY price ASC`,
    [operator, circle]
  );

  return rows.map((r) => ({
    id: r.id,
    operator: r.operator as Operator,
    circle: r.circle,
    price: r.price,
    validity: r.validity,
    data: r.data,
    calls: r.calls,
    sms: r.sms,
    description: r.description,
    type: 'prepaid' as const,
  }));
}

async function isCacheStale(operator: Operator, circle: string): Promise<boolean> {
  const row = await queryOne<{ fetched_at: Date }>(
    `SELECT fetched_at FROM operator_plans
     WHERE operator = $1 AND circle = $2
     ORDER BY fetched_at DESC LIMIT 1`,
    [operator, circle]
  );
  if (!row) return true;
  return Date.now() - new Date(row.fetched_at).getTime() > CACHE_TTL_MS;
}

/**
 * Get plans for an operator+circle. Serves from cache when fresh, re-fetches when stale.
 */
export async function getPlans(
  operator: Operator,
  circle: string,
  maxPrice?: number
): Promise<RechargePlan[]> {
  const stale = await isCacheStale(operator, circle);
  const plans = stale
    ? await fetchAndCachePlans(operator, circle)
    : await getPlansFromCache(operator, circle);

  if (maxPrice) {
    return plans.filter((p) => p.price <= maxPrice);
  }
  return plans;
}

/**
 * Get popular plans (most common price points: ₹19, ₹49, ₹99, ₹149, ₹199, ₹239, ₹299, ₹399, ₹599, ₹999).
 */
export async function getPopularPlans(operator: Operator, circle: string): Promise<RechargePlan[]> {
  const all = await getPlans(operator, circle);
  const popularPrices = [19, 49, 99, 149, 199, 239, 299, 399, 599, 999];

  // Return exact matches first, then fill up to 5 plans total
  const popular = popularPrices
    .map((price) => all.find((p) => p.price === price))
    .filter((p): p is RechargePlan => !!p)
    .slice(0, 5);

  if (popular.length < 5) {
    const extras = all.filter((p) => !popularPrices.includes(p.price)).slice(0, 5 - popular.length);
    return [...popular, ...extras];
  }
  return popular;
}

/**
 * Look up a single plan by ID from the cache.
 */
export async function getPlanById(planId: string): Promise<RechargePlan | null> {
  const row = await queryOne<{
    id: string; operator: string; circle: string; price: number;
    validity: string; data: string; calls: string; sms: string;
    description: string; plan_type: string;
  }>(
    `SELECT id, operator, circle, price, validity, data, calls, sms, description, plan_type
     FROM operator_plans WHERE id = $1`,
    [planId]
  );
  if (!row) return null;
  return {
    id: row.id,
    operator: row.operator as Operator,
    circle: row.circle,
    price: row.price,
    validity: row.validity,
    data: row.data,
    calls: row.calls,
    sms: row.sms,
    description: row.description,
    type: 'prepaid',
  };
}

/**
 * Format a list of plans into a readable WhatsApp message.
 */
export function formatPlansMessage(plans: RechargePlan[], operator: Operator): string {
  if (plans.length === 0) {
    return `No plans found for ${operator}. Please try a different amount or contact support.`;
  }

  const lines = plans.map((p, i) => {
    const parts = [`*${i + 1}.* ₹${p.price}`];
    if (p.validity) parts.push(`| ${p.validity}`);
    if (p.data) parts.push(`| ${p.data}`);
    if (p.calls) parts.push(`| ${p.calls}`);
    return parts.join(' ');
  });

  return `📱 *${operator} Plans:*\n\n${lines.join('\n')}\n\nReply with the plan number to recharge, or type the amount directly.`;
}
