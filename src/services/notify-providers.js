import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { toInternationalNg } from '../utils/phone.js';

// Providers are chosen with NOTIFY_EMAIL_PROVIDER / NOTIFY_SMS_PROVIDER. 'log' sends nothing (safe default).
// The Resend and Termii adapters follow those services' documented HTTP APIs but have not been run against the
// live services from here: send yourself a test message first. Adding another provider = one more entry below.
const mask = (s) => String(s).replace(/(.{2}).+(.{2})$/, '$1***$2');

async function postJson(url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch {
    throw new AppError(502, 'PROVIDER_UNREACHABLE', 'Could not reach the messaging provider');
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new AppError(502, 'PROVIDER_ERROR', `Provider responded ${res.status}: ${String(json?.message ?? json?.error ?? '').slice(0, 150)}`);
  return json ?? {};
}

const logProvider = (channel) => async ({ to, subject }) => {
  console.log(`[notify:${channel}:log] to=${mask(to)}${subject ? ` subject="${subject}"` : ''}`);
  return { providerId: 'log' };
};

const emailProviders = {
  log: logProvider('email'),
  resend: async ({ to, subject, body }) => {
    const r = await postJson('https://api.resend.com/emails', { from: env.EMAIL_FROM, to: [to], subject, text: body }, { Authorization: `Bearer ${env.RESEND_API_KEY}` });
    return { providerId: r.id ?? 'resend' };
  },
};

const smsProviders = {
  log: logProvider('sms'),
  termii: async ({ to, body }) => {
    const r = await postJson('https://api.termii.com/api/sms/send', {
      to: toInternationalNg(to), from: env.TERMII_SENDER_ID, sms: body, type: 'plain', channel: 'generic', api_key: env.TERMII_API_KEY,
    });
    return { providerId: r.message_id ?? 'termii' };
  },
};

export const sendMessage = (channel, msg) => (channel === 'email' ? emailProviders[env.NOTIFY_EMAIL_PROVIDER] : smsProviders[env.NOTIFY_SMS_PROVIDER])(msg);
