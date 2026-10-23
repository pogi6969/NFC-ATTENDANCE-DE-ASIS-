'use strict';

const TIMEOUT_MS = 15000;

async function readError(res) {
  const body = await res.text().catch(() => '');
  try {
    const data = JSON.parse(body);
    const msg = data.message || data.error || (Array.isArray(data) ? data[0]?.message : '') || JSON.stringify(data);
    return `HTTP ${res.status}: ${String(msg).slice(0, 300)}`;
  } catch {
    return `HTTP ${res.status}: ${body.slice(0, 300)}`;
  }
}

function createSms(config) {
  const { provider } = config.sms;
  const outbox = [];

  function status() {
    const s = config.sms;
    const configured = {
      console: true,
      none: false,
      semaphore: !!s.semaphore.apiKey,
      twilio: !!(s.twilio.accountSid && s.twilio.authToken && s.twilio.from),
      webhook: !!s.webhook.url,
    }[provider];
    return { provider, configured: !!configured };
  }

  async function send(to, message) {
    switch (provider) {
      case 'console': {
        outbox.push({ to, message, at: new Date().toISOString() });
        if (outbox.length > 50) outbox.shift();
        if (!config.quiet) console.log(`[sms] to ${to}: ${message}`);
        return 'console';
      }
      case 'semaphore': {
        const s = config.sms.semaphore;
        if (!s.apiKey) throw new Error('SEMAPHORE_API_KEY is not set.');
        // Semaphore takes local Philippine numbers: +639171234567 -> 09171234567
        const number = to.startsWith('+63') ? `0${to.slice(3)}` : to.replace(/^\+/, '');
        const form = new URLSearchParams({ apikey: s.apiKey, number, message });
        if (s.senderName) form.set('sendername', s.senderName);
        const res = await fetch('https://api.semaphore.co/api/v4/messages', {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json().catch(() => null);
        const first = Array.isArray(data) ? data[0] : data;
        if (!first || !first.message_id) throw new Error(`Semaphore did not accept the message: ${JSON.stringify(data).slice(0, 300)}`);
        return String(first.message_id);
      }
      case 'twilio': {
        const t = config.sms.twilio;
        if (!t.accountSid || !t.authToken || !t.from) throw new Error('Twilio settings are incomplete.');
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(t.accountSid)}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64')}` },
          body: new URLSearchParams({ To: to, From: t.from, Body: message }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();
        return data.sid;
      }
      case 'webhook': {
        const w = config.sms.webhook;
        if (!w.url) throw new Error('SMS_WEBHOOK_URL is not set.');
        const headers = { 'Content-Type': 'application/json' };
        if (w.token) headers.Authorization = `Bearer ${w.token}`;
        const res = await fetch(w.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ to, message }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(await readError(res));
        return 'webhook';
      }
      case 'none':
        throw new Error('Text messages are turned off on the server (SMS_PROVIDER=none).');
      default:
        throw new Error(`Unknown SMS_PROVIDER "${provider}".`);
    }
  }

  return { send, status, outbox };
}

module.exports = { createSms };
