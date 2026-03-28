import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  database: {
    url: required('DATABASE_URL'),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
  },

  paysprint: {
    apiKey: required('PAYSPRINT_API_KEY'),
    memberId: required('PAYSPRINT_MEMBER_ID'),
    baseUrl: process.env.PAYSPRINT_BASE_URL ?? 'https://sit.paysprint.in/service-api/api/v1',
  },

  komparify: {
    apiKey: required('KOMPARIFY_API_KEY'),
    baseUrl: process.env.KOMPARIFY_BASE_URL ?? 'https://www.komparify.com/api',
  },

  phonepe: {
    merchantId: required('PHONEPE_MERCHANT_ID'),
    saltKey: required('PHONEPE_SALT_KEY'),
    saltIndex: parseInt(process.env.PHONEPE_SALT_INDEX ?? '1', 10),
    baseUrl: process.env.PHONEPE_BASE_URL ?? 'https://api-preprod.phonepe.com/apis/pg-sandbox',
    redirectUrl: required('PHONEPE_REDIRECT_URL'),
    callbackUrl: required('PHONEPE_CALLBACK_URL'),
  },

  gupshup: {
    userId: required('2000264091'),
    password: required('C@Ltk#SX'),
    whatsappNumber: required('917835854817'),
  },

  platform: {
    feePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '0.5'),
  },
};
