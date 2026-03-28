// ─── User & Account ───────────────────────────────────────────────────────────

export type UserType = 'consumer' | 'retailer';
export type KycStatus = 'pending' | 'verified' | 'rejected';

export interface User {
  id: string;
  whatsappNumber: string;
  name: string | null;
  type: UserType;
  walletBalance: number; // in paise (₹1 = 100 paise)
  kycStatus: KycStatus;
  createdAt: Date;
}

// ─── Operator & Plans ─────────────────────────────────────────────────────────

export type Operator = 'JIO' | 'AIRTEL' | 'VI' | 'BSNL' | 'MTNL';

export const OPERATOR_CODES: Record<Operator, string> = {
  JIO: 'JIO',
  AIRTEL: 'AIRTEL',
  VI: 'VI',
  BSNL: 'BSNL',
  MTNL: 'MTNL',
};

export interface RechargePlan {
  id: string;
  operator: Operator;
  circle: string;
  price: number;         // in rupees
  validity: string;      // e.g. "28 days", "365 days"
  data: string;          // e.g. "2GB/day", "100GB total"
  calls: string;         // e.g. "Unlimited", "300 mins/day"
  sms: string;           // e.g. "100/day"
  description: string;
  type: 'prepaid' | 'postpaid';
}

// ─── Recharge Transaction ──────────────────────────────────────────────────────

export type TransactionStatus =
  | 'pending_payment'
  | 'payment_received'
  | 'recharge_initiated'
  | 'recharge_success'
  | 'recharge_failed'
  | 'refunded';

export interface Transaction {
  id: string;
  userId: string;
  mobileNumber: string;
  operator: Operator;
  circle: string;
  planId: string | null;
  amount: number;           // in rupees
  commissionEarned: number; // in paise
  cashbackGiven: number;    // in paise
  status: TransactionStatus;
  upiRef: string | null;
  paysrpintRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Payment ──────────────────────────────────────────────────────────────────

export interface PaymentOrder {
  orderId: string;
  transactionId: string;
  amount: number; // in rupees
  upiLink: string;
  qrCode?: string;
  expiresAt: Date;
}

export interface PaymentCallback {
  merchantTransactionId: string;
  transactionId: string;
  amount: number; // in paise
  status: 'PAYMENT_SUCCESS' | 'PAYMENT_ERROR' | 'PAYMENT_PENDING';
  paymentInstrument?: {
    type: string;
    utr?: string;
  };
}

// ─── Recharge API ─────────────────────────────────────────────────────────────

export interface RechargeRequest {
  mobile: string;
  operator: string;
  circle: string;
  amount: number;
  transactionId: string;
}

export interface RechargeResponse {
  success: boolean;
  operatorRef?: string;
  message: string;
}

// ─── Conversation State ───────────────────────────────────────────────────────

export type ConversationStep =
  | 'idle'
  | 'awaiting_mobile'
  | 'awaiting_operator'
  | 'awaiting_plan_selection'
  | 'awaiting_payment'
  | 'processing_recharge'
  | 'completed';

export interface ConversationState {
  userId: string;
  step: ConversationStep;
  mobile?: string;
  operator?: Operator;
  circle?: string;
  selectedPlan?: RechargePlan;
  transactionId?: string;
  lastMessageAt: Date;
}

// ─── Claude NLU ───────────────────────────────────────────────────────────────

export interface ParsedIntent {
  intent: 'recharge' | 'show_plans' | 'check_balance' | 'transaction_history' | 'help' | 'unknown';
  mobile?: string;
  operator?: Operator;
  amount?: number;
  circle?: string;
  rawText: string;
}

// ─── Gupshup Webhook ──────────────────────────────────────────────────────────

export interface GupshupMessage {
  app: string;
  timestamp: string;
  type: 'message' | 'message-event';
  payload: {
    id: string;
    source: string;           // sender's WhatsApp number
    type: 'text' | 'interactive' | 'button';
    payload: {
      text?: string;
      title?: string;
      id?: string;
    };
    sender: {
      phone: string;
      name: string;
    };
  };
}
