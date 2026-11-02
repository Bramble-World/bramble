import { connect } from 'node:http2';
import { SignJWT, importPKCS8 } from 'jose';
import { env } from '@/env';
import type { PushEnvironment, PushMessage, PushOutcome } from './push.types';

/**
 * Sends one notification through Apple's push service.
 *
 * Node's `http2` rather than `fetch`, because APNs only speaks HTTP/2 and Node's
 * fetch doesn't negotiate it.
 */

/** The app's bundle id: Apple routes a notification to the app by this. */
const TOPIC = 'com.brambleworld.BrambleMobile';

const HOSTS: Record<PushEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/**
 * Apple rejects a provider token older than an hour and throttles one replaced
 * more often than every twenty minutes, so it is kept for forty.
 */
const PROVIDER_TOKEN_MS = 40 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 10_000;

/** Reasons that mean the token itself is dead, not that this send failed. */
const DEAD_TOKEN = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

let providerToken: { value: string; madeAt: number } | null = null;

export function apnsConfigured(): boolean {
  return Boolean(env.APPLE_TEAM_ID && env.APNS_KEY_ID && env.APNS_PRIVATE_KEY);
}

async function bearer(): Promise<string> {
  if (providerToken && Date.now() - providerToken.madeAt < PROVIDER_TOKEN_MS) {
    return providerToken.value;
  }
  if (!apnsConfigured()) throw new Error('APNs is not configured.');
  // Doppler keeps multi-line values, but a key pasted as one line with literal
  // \n is common enough to accept.
  const key = await importPKCS8(env.APNS_PRIVATE_KEY!.replace(/\\n/g, '\n'), 'ES256');
  const value = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APNS_KEY_ID! })
    .setIssuer(env.APPLE_TEAM_ID!)
    .setIssuedAt()
    .sign(key);
  providerToken = { value, madeAt: Date.now() };
  return value;
}

/** Forgets the provider token, so a test can change the key. */
export function resetProviderToken() {
  providerToken = null;
}

/** What Apple's status and reason mean for this token. */
export function outcomeFrom(status: number, reason: string | undefined): PushOutcome {
  if (status === 200) return { kind: 'delivered' };
  const named = reason ?? `status ${status}`;
  return status === 410 || DEAD_TOKEN.has(named)
    ? { kind: 'gone', reason: named }
    : { kind: 'failed', reason: named };
}

/** `host` is only overridden by tests, to talk to a local server. */
export async function sendPush(
  device: { token: string; environment: PushEnvironment },
  message: PushMessage,
  host: string = HOSTS[device.environment]
): Promise<PushOutcome> {
  const authorization = `bearer ${await bearer()}`;
  const payload = JSON.stringify({
    aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
  });

  return new Promise((resolve) => {
    const session = connect(host);
    const finish = (outcome: PushOutcome) => {
      session.close();
      resolve(outcome);
    };
    session.on('error', (error) => finish({ kind: 'failed', reason: error.message }));

    const request = session.request({
      ':method': 'POST',
      ':path': `/3/device/${device.token}`,
      authorization,
      'apns-topic': TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.close();
      finish({ kind: 'failed', reason: 'timed out' });
    });
    request.on('error', (error) => finish({ kind: 'failed', reason: error.message }));

    let status = 0;
    let body = '';
    request.setEncoding('utf8');
    request.on('response', (headers) => {
      status = Number(headers[':status']);
    });
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      let reason: string | undefined;
      try {
        reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
      } catch {
        reason = undefined;
      }
      finish(outcomeFrom(status, reason));
    });
    request.end(payload);
  });
}
