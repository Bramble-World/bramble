// @vitest-environment node
import { createServer, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair, jwtVerify, type CryptoKey } from 'jose';

vi.mock('@/env', () => ({
  env: { APPLE_TEAM_ID: 'TEAMID1234', APNS_KEY_ID: 'KEYID12345', APNS_PRIVATE_KEY: '' },
}));

const { env } = await import('@/env');
const { outcomeFrom, resetProviderToken, sendPush } = await import('./apns');

type Seen = { headers: Record<string, unknown>; body: string };

let server: Http2Server;
let host: string;
let publicKey: CryptoKey;
let seen: Seen[] = [];
let answer = { status: 200, body: '' };

const device = { token: 'ab'.repeat(32), environment: 'production' as const };
const message = { title: 'bramble', body: 'your story is waiting.' };

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  publicKey = pair.publicKey;
  (env as { APNS_PRIVATE_KEY: string }).APNS_PRIVATE_KEY = await exportPKCS8(pair.privateKey);

  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      seen.push({ headers: { ...request.headers }, body });
      response.writeHead(answer.status);
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  seen = [];
  answer = { status: 200, body: '' };
  resetProviderToken();
});

describe('sendPush', () => {
  it('sends what Apple asks for, signed with the key', async () => {
    expect(await sendPush(device, message, host)).toEqual({ kind: 'delivered' });

    const [{ headers, body }] = seen;
    expect(headers[':path']).toBe(`/3/device/${device.token}`);
    expect(headers['apns-topic']).toBe('com.brambleworld.BrambleMobile');
    expect(headers['apns-push-type']).toBe('alert');
    expect(JSON.parse(body)).toEqual({
      aps: { alert: message, sound: 'default' },
    });

    const jwt = String(headers.authorization).replace('bearer ', '');
    const { payload, protectedHeader } = await jwtVerify(jwt, publicKey);
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEYID12345' });
    expect(payload.iss).toBe('TEAMID1234');
  });

  it('reuses the provider token between sends', async () => {
    await sendPush(device, message, host);
    await sendPush(device, message, host);
    expect(seen[0].headers.authorization).toBe(seen[1].headers.authorization);
  });

  it('reports a dead token as gone', async () => {
    answer = { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) };
    expect(await sendPush(device, message, host)).toEqual({ kind: 'gone', reason: 'Unregistered' });
  });

  it('reports an unreachable host as a failure, not a throw', async () => {
    const outcome = await sendPush(device, message, 'http://127.0.0.1:1');
    expect(outcome.kind).toBe('failed');
  });
});

describe('outcomeFrom', () => {
  it('treats a bad token as gone', () => {
    expect(outcomeFrom(400, 'BadDeviceToken').kind).toBe('gone');
    expect(outcomeFrom(400, 'DeviceTokenNotForTopic').kind).toBe('gone');
  });

  it('keeps the token when the fault is ours or Apple’s', () => {
    expect(outcomeFrom(403, 'InvalidProviderToken').kind).toBe('failed');
    expect(outcomeFrom(429, 'TooManyRequests').kind).toBe('failed');
    expect(outcomeFrom(503, undefined)).toEqual({ kind: 'failed', reason: 'status 503' });
  });
});
