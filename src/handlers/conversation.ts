import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, withTransaction } from '../db/index';
import { parseIntent, generateHelpResponse } from '../services/claude';
import { detectOperator, executeRecharge, checkRechargeStatus } from '../services/recharge';
import { getPlans, getPopularPlans, formatPlansMessage, getPlanById } from '../services/plans';
import { createPaymentOrder } from '../services/payment';
import { sendText, sendButtons } from '../services/gupshup';
import { config } from '../config/index';
import { logger } from '../config/logger';
import type {
  ConversationState, ConversationStep, User, Operator, RechargePlan, GupshupMessage
} from '../types/index';

// ─── User helpers ──────────────────────────────────────────────────────────────

async function getOrCreateUser(whatsappNumber: string, name: string): Promise<User> {
  let user = await queryOne<User>(
    'SELECT * FROM users WHERE whatsapp_number = $1',
    [whatsappNumber]
  );

  if (!user) {
    const rows = await query<User>(
      `INSERT INTO users (id, whatsapp_number, name, type, wallet_balance, kyc_status)
       VALUES ($1, $2, $3, 'consumer', 0, 'pending') RETURNING *`,
      [uuidv4(), whatsappNumber, name || null]
    );
    user = rows[0];
    logger.info('New user created', { whatsappNumber });
  }

  return user;
}

async function getConversationState(userId: string): Promise<ConversationState> {
  const row = await queryOne<{
    step: string; mobile: string | null; operator: string | null;
    circle: string | null; selected_plan: RechargePlan | null;
    transaction_id: string | null; last_message_at: Date;
  }>(
    'SELECT * FROM conversation_state WHERE user_id = $1',
    [userId]
  );

  if (!row) {
    return { userId, step: 'idle', lastMessageAt: new Date() };
  }

  return {
    userId,
    step: row.step as ConversationStep,
    mobile: row.mobile ?? undefined,
    operator: row.operator as Operator | undefined,
    circle: row.circle ?? undefined,
    selectedPlan: row.selected_plan ?? undefined,
    transactionId: row.transaction_id ?? undefined,
    lastMessageAt: row.last_message_at,
  };
}

async function saveConversationState(state: ConversationState): Promise<void> {
  await query(
    `INSERT INTO conversation_state (user_id, step, mobile, operator, circle, selected_plan, transaction_id, last_message_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       step=$2, mobile=$3, operator=$4, circle=$5,
       selected_plan=$6, transaction_id=$7, last_message_at=NOW()`,
    [
      state.userId,
      state.step,
      state.mobile ?? null,
      state.operator ?? null,
      state.circle ?? null,
      state.selectedPlan ? JSON.stringify(state.selectedPlan) : null,
      state.transactionId ?? null,
    ]
  );
}

async function resetState(userId: string): Promise<void> {
  await saveConversationState({ userId, step: 'idle', lastMessageAt: new Date() });
}

// ─── Commission / cashback calculation ───────────────────────────────────────

function calculateCashback(amountRupees: number, commissionPercent: number): {
  commissionPaise: number;
  cashbackPaise: number;
  platformFeePaise: number;
} {
  const commissionPaise = Math.floor((amountRupees * commissionPercent) / 100 * 100);
  const platformFeePaise = Math.floor((amountRupees * config.platform.feePercent) / 100 * 100);
  const cashbackPaise = Math.max(0, commissionPaise - platformFeePaise);
  return { commissionPaise, cashbackPaise, platformFeePaise };
}

// ─── Main conversation handler ────────────────────────────────────────────────

export async function handleMessage(msg: GupshupMessage): Promise<void> {
  const { source, payload: msgPayload, sender } = msg.payload;
  const text = msgPayload.text ?? msgPayload.title ?? '';
  const whatsappNumber = source.replace(/^91/, ''); // normalize to 10 digits internally

  logger.info('Handling message', { from: whatsappNumber, text: text.slice(0, 80) });

  const user = await getOrCreateUser(whatsappNumber, sender.name);
  const state = await getConversationState(user.id);

  // Reset stale conversations (>30 min of inactivity)
  const staleMins = (Date.now() - new Date(state.lastMessageAt).getTime()) / 60000;
  if (staleMins > 30 && state.step !== 'idle') {
    await resetState(user.id);
    state.step = 'idle';
    state.mobile = undefined;
    state.operator = undefined;
    state.selectedPlan = undefined;
  }

  await routeMessage(user, state, text, whatsappNumber);
}

async function routeMessage(
  user: User,
  state: ConversationState,
  text: string,
  whatsappNumber: string
): Promise<void> {
  // Handle global commands at any step
  const lower = text.toLowerCase().trim();
  if (['cancel', 'quit', 'exit', 'stop', 'reset'].includes(lower)) {
    await resetState(user.id);
    await sendText(whatsappNumber, '✅ Cancelled. Type "recharge" to start again.');
    return;
  }

  if (['hi', 'hello', 'hey', 'hii', 'start'].includes(lower)) {
    await sendWelcome(whatsappNumber, user.type);
    return;
  }

  switch (state.step) {
    case 'idle':
      return handleIdle(user, state, text, whatsappNumber);
    case 'awaiting_mobile':
      return handleAwaitingMobile(user, state, text, whatsappNumber);
    case 'awaiting_operator':
      return handleAwaitingOperator(user, state, text, whatsappNumber);
    case 'awaiting_plan_selection':
      return handleAwaitingPlanSelection(user, state, text, whatsappNumber);
    case 'awaiting_payment':
      await sendText(whatsappNumber, '⏳ Waiting for your payment. Click the link sent earlier to pay, or type "cancel" to abort.');
      return;
    default:
      return handleIdle(user, state, text, whatsappNumber);
  }
}

async function sendWelcome(whatsappNumber: string, userType: string): Promise<void> {
  const msg = userType === 'retailer'
    ? `👋 Welcome back! I can help you:\n• Recharge any mobile number\n• Check plans\n• View wallet balance\n\nType a 10-digit mobile number to start recharging!`
    : `👋 Hello! I'm your mobile recharge assistant.\n\nI can recharge *Jio, Airtel, Vi, BSNL* mobiles.\n\nType a mobile number or send "recharge" to get started!`;
  await sendText(whatsappNumber, msg);
}

async function handleIdle(
  user: User,
  state: ConversationState,
  text: string,
  whatsappNumber: string
): Promise<void> {
  // Check for inline "recharge 9876543210 jio 199"
  const isMobile = /^[6-9]\d{9}$/.test(text.replace(/\s/g, ''));
  if (isMobile) {
    return handleMobileNumber(user, state, text.replace(/\s/g, ''), whatsappNumber);
  }

  const intent = await parseIntent(text);

  switch (intent.intent) {
    case 'recharge':
    case 'show_plans': {
      if (intent.mobile) {
        await handleMobileNumber(user, state, intent.mobile, whatsappNumber, intent.operator, intent.circle);
      } else {
        state.step = 'awaiting_mobile';
        if (intent.operator) state.operator = intent.operator;
        await saveConversationState(state);
        await sendText(whatsappNumber, '📱 Please enter the 10-digit mobile number to recharge:');
      }
      break;
    }
    case 'check_balance': {
      const balanceRs = (user.walletBalance / 100).toFixed(2);
      await sendText(whatsappNumber, `💰 Your wallet balance: *₹${balanceRs}*\n\nThis cashback is applied automatically on your next recharge!`);
      break;
    }
    case 'transaction_history': {
      await sendTransactionHistory(user.id, whatsappNumber);
      break;
    }
    case 'help':
    case 'unknown': {
      const reply = await generateHelpResponse(text);
      await sendText(whatsappNumber, reply);
      break;
    }
  }
}

async function handleMobileNumber(
  user: User,
  state: ConversationState,
  mobile: string,
  whatsappNumber: string,
  operator?: Operator,
  circle?: string
): Promise<void> {
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    await sendText(whatsappNumber, '❌ Invalid mobile number. Please enter a valid 10-digit Indian mobile number.');
    return;
  }

  state.mobile = mobile;
  await sendText(whatsappNumber, `🔍 Looking up operator for ${mobile}...`);

  // Auto-detect operator if not provided
  if (!operator) {
    const detected = await detectOperator(mobile);
    if (detected) {
      operator = detected.operator;
      circle = detected.circle;
    }
  }

  if (operator) {
    state.operator = operator;
    state.circle = circle ?? 'Delhi';
    await handleShowPlans(user, state, whatsappNumber);
  } else {
    state.step = 'awaiting_operator';
    await saveConversationState(state);
    await sendButtons(whatsappNumber, `📱 Mobile: *${mobile}*\n\nWhich operator?`, [
      { id: 'JIO', title: '🔵 Jio' },
      { id: 'AIRTEL', title: '🔴 Airtel' },
      { id: 'VI', title: '💜 Vi' },
      { id: 'BSNL', title: '🟢 BSNL' },
    ]);
  }
}

async function handleAwaitingMobile(
  user: User,
  state: ConversationState,
  text: string,
  whatsappNumber: string
): Promise<void> {
  const mobile = text.replace(/[\s+\-]/g, '').replace(/^91/, '');
  await handleMobileNumber(user, state, mobile, whatsappNumber, state.operator);
}

async function handleAwaitingOperator(
  user: User,
  state: ConversationState,
  text: string,
  whatsappNumber: string
): Promise<void> {
  const operatorMap: Record<string, Operator> = {
    jio: 'JIO', JIO: 'JIO',
    airtel: 'AIRTEL', AIRTEL: 'AIRTEL',
    vi: 'VI', VI: 'VI', vodafone: 'VI', idea: 'VI',
    bsnl: 'BSNL', BSNL: 'BSNL',
    mtnl: 'MTNL', MTNL: 'MTNL',
  };

  const operator = operatorMap[text.trim()] ?? operatorMap[text.trim().toLowerCase()];

  if (!operator) {
    const intent = await parseIntent(text);
    if (!intent.operator) {
      await sendText(whatsappNumber, '❓ Please select an operator: *Jio, Airtel, Vi, or BSNL*');
      return;
    }
    state.operator = intent.operator;
  } else {
    state.operator = operator;
  }

  state.circle = state.circle ?? 'Delhi';
  await handleShowPlans(user, state, whatsappNumber);
}

async function handleShowPlans(
  user: User,
  state: ConversationState,
  whatsappNumber: string
): Promise<void> {
  const { operator, circle, mobile } = state;
  if (!operator || !mobile) return;

  await sendText(whatsappNumber, `⏳ Fetching ${operator} plans...`);

  const plans = await getPopularPlans(operator, circle ?? 'Delhi');

  if (plans.length === 0) {
    await sendText(whatsappNumber, `❌ No plans found for ${operator}. Please try entering a recharge amount directly.`);
    state.step = 'awaiting_plan_selection';
    await saveConversationState(state);
    return;
  }

  state.step = 'awaiting_plan_selection';
  await saveConversationState(state);

  const msg = formatPlansMessage(plans, operator);
  await sendText(whatsappNumber, msg);
}

async function handleAwaitingPlanSelection(
  user: User,
  state: ConversationState,
  text: string,
  whatsappNumber: string
): Promise<void> {
  const { operator, circle, mobile } = state;
  if (!operator || !mobile) {
    await resetState(user.id);
    return;
  }

  // User typed a plan index (1, 2, 3...)
  const planIndex = parseInt(text.trim(), 10);
  let selectedPlan: RechargePlan | undefined;

  if (!isNaN(planIndex) && planIndex >= 1 && planIndex <= 10) {
    const plans = await getPopularPlans(operator, circle ?? 'Delhi');
    selectedPlan = plans[planIndex - 1];
  }

  // User typed an amount directly (e.g. "199")
  if (!selectedPlan) {
    const amount = parseInt(text.replace(/[₹\s]/g, ''), 10);
    if (!isNaN(amount) && amount >= 10 && amount <= 5000) {
      const allPlans = await getPlans(operator, circle ?? 'Delhi');
      selectedPlan = allPlans.find((p) => p.price === amount);

      if (!selectedPlan) {
        // No exact match — treat as custom amount
        selectedPlan = {
          id: uuidv4(),
          operator,
          circle: circle ?? 'Delhi',
          price: amount,
          validity: '',
          data: '',
          calls: '',
          sms: '',
          description: 'Custom amount',
          type: 'prepaid',
        };
      }
    }
  }

  if (!selectedPlan) {
    const intent = await parseIntent(text, `User is selecting a plan for ${operator} ${mobile}`);
    if (intent.amount) {
      selectedPlan = {
        id: uuidv4(),
        operator,
        circle: circle ?? 'Delhi',
        price: intent.amount,
        validity: '',
        data: '',
        calls: '',
        sms: '',
        description: '',
        type: 'prepaid',
      };
    }
  }

  if (!selectedPlan) {
    await sendText(whatsappNumber, '❓ Please select a plan by number (1, 2, 3...) or type the amount (e.g. "199").');
    return;
  }

  state.selectedPlan = selectedPlan;
  await initiatePayment(user, state, whatsappNumber);
}

async function initiatePayment(
  user: User,
  state: ConversationState,
  whatsappNumber: string
): Promise<void> {
  const { mobile, operator, selectedPlan } = state;
  if (!mobile || !operator || !selectedPlan) return;

  // Deduct wallet cashback if available
  const walletDeductPaise = Math.min(user.walletBalance, selectedPlan.price * 100);
  const chargeAmountRupees = selectedPlan.price - Math.floor(walletDeductPaise / 100);

  // Create transaction record
  const txnId = uuidv4();
  await query(
    `INSERT INTO transactions (id, user_id, mobile_number, operator, circle, plan_id, amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_payment')`,
    [txnId, user.id, mobile, operator, state.circle ?? 'Delhi',
     selectedPlan.id.length === 36 ? selectedPlan.id : null,
     selectedPlan.price]
  );

  state.transactionId = txnId;
  state.step = 'awaiting_payment';
  await saveConversationState(state);

  const cashbackNote = walletDeductPaise > 0
    ? `\n💰 ₹${(walletDeductPaise / 100).toFixed(0)} wallet cashback applied!`
    : '';

  const summary = `📋 *Recharge Summary*\n` +
    `• Mobile: ${mobile}\n` +
    `• Operator: ${operator}\n` +
    `• Plan: ₹${selectedPlan.price}${selectedPlan.validity ? ` | ${selectedPlan.validity}` : ''}` +
    `${selectedPlan.data ? ` | ${selectedPlan.data}` : ''}\n` +
    `• Amount to pay: *₹${chargeAmountRupees}*${cashbackNote}`;

  await sendText(whatsappNumber, summary);

  try {
    const order = await createPaymentOrder(txnId, chargeAmountRupees, mobile);

    const payMsg = `💳 *Pay ₹${chargeAmountRupees} via UPI:*\n\n` +
      `${order.upiLink}\n\n` +
      `⏰ Link expires in 15 minutes.\n` +
      `Type "cancel" to abort this recharge.`;

    await sendText(whatsappNumber, payMsg);
  } catch {
    await sendText(whatsappNumber, '❌ Unable to create payment link right now. Please try again in a moment.');
    await resetState(user.id);
  }
}

// ─── Payment confirmed (called from webhook) ──────────────────────────────────

export async function handlePaymentConfirmed(
  merchantTransactionId: string,
  upiRef: string
): Promise<void> {
  // merchantTransactionId format: RCHG_<txnId without dashes>
  const rows = await query<{ id: string; user_id: string; mobile_number: string; operator: string; circle: string; amount: number }>(
    `SELECT t.id, t.user_id, t.mobile_number, t.operator, t.circle, t.amount
     FROM transactions t
     WHERE t.id::text ILIKE $1 AND t.status = 'pending_payment'
     LIMIT 1`,
    [`%${merchantTransactionId.replace('RCHG_', '').slice(0, 20)}%`]
  );

  if (!rows.length) {
    logger.warn('No pending transaction found for payment', { merchantTransactionId });
    return;
  }

  const txn = rows[0];

  await query(
    `UPDATE transactions SET status='payment_received', upi_ref=$1, updated_at=NOW() WHERE id=$2`,
    [upiRef, txn.id]
  );

  logger.info('Payment received, executing recharge', { txnId: txn.id });

  // Trigger recharge
  const result = await executeRecharge({
    mobile: txn.mobile_number,
    operator: txn.operator,
    circle: txn.circle,
    amount: txn.amount,
    transactionId: txn.id,
  });

  const user = await queryOne<User>('SELECT * FROM users WHERE id = $1', [txn.user_id]);
  if (!user) return;

  const userPhone = user.whatsappNumber;

  if (result.success) {
    // Calculate and credit cashback
    const COMMISSION_PERCENT = 3; // ~3% from PaySprint
    const { cashbackPaise } = calculateCashback(txn.amount, COMMISSION_PERCENT);

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE transactions SET status='recharge_success', paysprint_ref=$1, commission_earned=$2, cashback_given=$3, updated_at=NOW() WHERE id=$4`,
        [result.operatorRef, Math.floor(txn.amount * COMMISSION_PERCENT), cashbackPaise, txn.id]
      );
      if (cashbackPaise > 0) {
        await client.query(
          `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`,
          [cashbackPaise, txn.user_id]
        );
        await client.query(
          `INSERT INTO wallet_ledger (id, user_id, amount, type, ref_txn_id, note)
           VALUES ($1, $2, $3, 'cashback', $4, $5)`,
          [uuidv4(), txn.user_id, cashbackPaise, txn.id, `Cashback on ₹${txn.amount} recharge`]
        );
      }
    });

    const successMsg = `✅ *Recharge Successful!*\n\n` +
      `📱 ${txn.mobile_number} (${txn.operator})\n` +
      `💵 ₹${txn.amount} recharged\n` +
      `🔖 Operator Ref: ${result.operatorRef ?? 'N/A'}` +
      (cashbackPaise > 0 ? `\n💰 ₹${(cashbackPaise / 100).toFixed(2)} cashback added to your wallet!` : '');

    await sendText(userPhone, successMsg);
    await resetState(txn.user_id);
  } else {
    await query(
      `UPDATE transactions SET status='recharge_failed', failure_reason=$1, updated_at=NOW() WHERE id=$2`,
      [result.message, txn.id]
    );

    // Trigger refund (handled by PhonePe auto-refund or manually)
    await sendText(
      userPhone,
      `❌ *Recharge Failed*\n\n${result.message}\n\nYour payment will be refunded within 3-5 business days. Reference: ${txn.id.slice(0, 8).toUpperCase()}`
    );
    await resetState(txn.user_id);
  }
}

// ─── Transaction history ───────────────────────────────────────────────────────

async function sendTransactionHistory(userId: string, whatsappNumber: string): Promise<void> {
  const rows = await query<{
    mobile_number: string; operator: string; amount: number; status: string; created_at: Date;
  }>(
    `SELECT mobile_number, operator, amount, status, created_at
     FROM transactions WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 5`,
    [userId]
  );

  if (!rows.length) {
    await sendText(whatsappNumber, "You haven't done any recharges yet. Type \"recharge\" to get started!");
    return;
  }

  const lines = rows.map((t, i) => {
    const date = new Date(t.created_at).toLocaleDateString('en-IN');
    const statusIcon = t.status === 'recharge_success' ? '✅' : t.status === 'recharge_failed' ? '❌' : '⏳';
    return `${statusIcon} ${i + 1}. ${t.mobile_number} (${t.operator}) — ₹${t.amount} — ${date}`;
  });

  await sendText(whatsappNumber, `📜 *Last 5 Recharges:*\n\n${lines.join('\n')}`);
}

// Suppress unused import warnings
void checkRechargeStatus;
void getPlanById;
