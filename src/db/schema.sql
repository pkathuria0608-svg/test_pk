CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  whatsapp_number   VARCHAR(15) UNIQUE NOT NULL,
  name              VARCHAR(100),
  type              VARCHAR(10) NOT NULL DEFAULT 'consumer' CHECK (type IN ('consumer', 'retailer')),
  wallet_balance    BIGINT NOT NULL DEFAULT 0,
  kyc_status        VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_whatsapp ON users(whatsapp_number);

CREATE TABLE IF NOT EXISTS operator_plans (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator    VARCHAR(10) NOT NULL,
  circle      VARCHAR(30) NOT NULL,
  price       INT NOT NULL,
  validity    VARCHAR(50),
  data        VARCHAR(50),
  calls       VARCHAR(50),
  sms         VARCHAR(50),
  description TEXT,
  plan_type   VARCHAR(10) NOT NULL DEFAULT 'prepaid',
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (operator, circle, price, plan_type)
);

CREATE INDEX IF NOT EXISTS idx_plans_operator_circle ON operator_plans(operator, circle);
CREATE INDEX IF NOT EXISTS idx_plans_price ON operator_plans(price);

CREATE TABLE IF NOT EXISTS transactions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id),
  mobile_number       VARCHAR(15) NOT NULL,
  operator            VARCHAR(10) NOT NULL,
  circle              VARCHAR(30) NOT NULL,
  plan_id             UUID REFERENCES operator_plans(id),
  amount              INT NOT NULL,
  commission_earned   INT NOT NULL DEFAULT 0,
  cashback_given      INT NOT NULL DEFAULT 0,
  status              VARCHAR(25) NOT NULL DEFAULT 'pending_payment'
                        CHECK (status IN ('pending_payment', 'payment_received', 'recharge_initiated',
                          'recharge_success', 'recharge_failed', 'refunded')),
  upi_ref             VARCHAR(100),
  paysprint_ref       VARCHAR(100),
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_txn_upi_ref ON transactions(upi_ref);

CREATE TABLE IF NOT EXISTS conversation_state (
  user_id         UUID PRIMARY KEY REFERENCES users(id),
  step            VARCHAR(30) NOT NULL DEFAULT 'idle',
  mobile          VARCHAR(15),
  operator        VARCHAR(10),
  circle          VARCHAR(30),
  selected_plan   JSONB,
  transaction_id  UUID REFERENCES transactions(id),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id),
  amount      BIGINT NOT NULL,
  type        VARCHAR(20) NOT NULL CHECK (type IN ('cashback', 'topup', 'recharge_debit', 'refund')),
  ref_txn_id  UUID REFERENCES transactions(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER transactions_updated_at BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER conversation_state_updated_at BEFORE UPDATE ON conversation_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
