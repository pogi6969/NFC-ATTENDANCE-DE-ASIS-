'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function parseTrustProxy(value) {
  if (value === undefined || value === '') return 'loopback';
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function loadConfig(overrides = {}) {
  const envFile = path.join(ROOT, '.env');
  if (!overrides.skipEnvFile && fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;

  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const config = {
    port: Number(env.PORT) || 3000,
    dataDir,
    dbPath: env.DB_PATH || path.join(dataDir, 'attendance.db'),
    publicDir: path.join(ROOT, 'public'),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    appSecret: env.APP_SECRET || '',
    timezone: env.SCHOOL_TIMEZONE || 'Asia/Manila',
    countryCode: (env.DEFAULT_COUNTRY_CODE || '63').replace(/\D/g, '') || '63',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    sms: {
      provider: (env.SMS_PROVIDER || 'console').toLowerCase(),
      semaphore: { apiKey: env.SEMAPHORE_API_KEY || '', senderName: env.SEMAPHORE_SENDER_NAME || '' },
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID || '',
        authToken: env.TWILIO_AUTH_TOKEN || '',
        from: env.TWILIO_FROM || '',
      },
      webhook: { url: env.SMS_WEBHOOK_URL || '', token: env.SMS_WEBHOOK_TOKEN || '' },
    },
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || '',
      privateKey: env.VAPID_PRIVATE_KEY || '',
      subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    },
    quiet: false,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'skipEnvFile') continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && config[key] && typeof config[key] === 'object') {
      config[key] = { ...config[key], ...value };
    } else {
      config[key] = value;
    }
  }

  if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  return config;
}

module.exports = { loadConfig };
