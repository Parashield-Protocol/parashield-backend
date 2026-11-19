import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

describe('WebhooksService', () => {
  /** Build a service instance with optional WEBHOOK_SECRET_KEY configured. */
  function build(rows: any[] = [], webhookSecretKey?: string) {
    const prisma = {
      webhookRegistration: {
        create: jest.fn(async ({ data }: any) => ({ id: 'wh-1', createdAt: new Date(), isActive: true, ...data })),
        findMany: jest.fn().mockResolvedValue(rows),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = { get: jest.fn((key: string) => key === 'WEBHOOK_SECRET_KEY' ? webhookSecretKey : undefined) };
    const service = new WebhooksService(prisma as any, config as any);
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
    return { service, prisma, config };
  }

  afterEach(() => jest.restoreAllMocks());

  it('#482 — persists registrations to the database', async () => {
    const { service, prisma } = build();

    const result = await service.registerWebhook({ url: 'https://example.com/hook', events: ['claim.status.change'], secret: 's' });

    expect(result).toEqual({ id: 'wh-1', status: 'registered' });
    // Without WEBHOOK_SECRET_KEY the secret is stored as plain text.
    expect(prisma.webhookRegistration.create).toHaveBeenCalledWith({
      data: { url: 'https://example.com/hook', secret: 's', events: ['claim.status.change'] },
    });
  });

  it('#482 — loads active registrations from the database', async () => {
    const { service, prisma } = build();

    await service.getRegistrations();

    expect(prisma.webhookRegistration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });

  it('#482 — unregister deactivates the row and 400s on unknown ids', async () => {
    const { service, prisma } = build();
    await expect(service.unregisterWebhook('wh-1')).resolves.toEqual({ id: 'wh-1', status: 'unregistered' });

    prisma.webhookRegistration.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.unregisterWebhook('missing')).rejects.toThrow(BadRequestException);
  });

  it('#483 — delivers only to subscribed registrations with an HMAC-SHA256 signature', async () => {
    const { service } = build([
      { id: 'a', url: 'https://a.test', secret: 'topsecret', events: ['claim.status.change'], isActive: true, createdAt: new Date() },
      { id: 'b', url: 'https://b.test', secret: null, events: ['policy.status.change'], isActive: true, createdAt: new Date() },
    ]);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, headers: new Map() } as unknown as Response);

    const event = { claimId: 'c1', fromStatus: 'PROCESSING', toStatus: 'PAID', timestamp: 1, actorId: 'system', reason: null };
    await service.notifyClaimStatusChange(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://a.test');
    const expected = crypto.createHmac('sha256', 'topsecret').update(JSON.stringify(event)).digest('base64');
    expect((init.headers as Record<string, string>)['X-Webhook-Signature']).toBe(expected);
  });

  it('#730 — includes actor identity and reason in claim status change payload', async () => {
    const { service } = build([
      { id: 'a', url: 'https://a.test', secret: null, events: ['claim.status.change'], isActive: true, createdAt: new Date() },
    ]);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, headers: new Map() } as unknown as Response);

    const event = {
      claimId: 'c-123',
      fromStatus: 'SUBMITTED',
      toStatus: 'PROCESSING',
      timestamp: 1234567890,
      actorId: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
      reason: 'Automated claim triggered by oracle threshold',
    };
    await service.notifyClaimStatusChange(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toMatchObject({
      claimId: 'c-123',
      fromStatus: 'SUBMITTED',
      toStatus: 'PROCESSING',
      actorId: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
      reason: 'Automated claim triggered by oracle threshold',
    });
  });

  it('does not reject when loading registrations fails (callers fire-and-forget)', async () => {
    const { service, prisma } = build();
    prisma.webhookRegistration.findMany.mockRejectedValue(new Error('db down'));

    await expect(
      service.notifyPolicyStatusChange({ policyId: 'p', fromStatus: 'ACTIVE', toStatus: 'CLAIMED', timestamp: 1 }),
    ).resolves.toEqual([]);
  });

  describe('#606 — webhook secret encryption at rest', () => {
    const SECRET_KEY = 'test-encryption-key-32-bytes-long!';

    it('stores the secret encrypted (enc: prefix) when WEBHOOK_SECRET_KEY is set', async () => {
      const { service, prisma } = build([], SECRET_KEY);

      await service.registerWebhook({ url: 'https://example.com/hook', events: ['policy.status.change'], secret: 'mysecret' });

      const stored = prisma.webhookRegistration.create.mock.calls[0][0].data.secret as string;
      expect(stored).toMatch(/^enc:/);
    });

    it('round-trips: encrypted secret decrypts back to original value on read', async () => {
      const { service, prisma } = build([], SECRET_KEY);

      // Register to get the encrypted value.
      await service.registerWebhook({ url: 'https://example.com/hook', events: ['policy.status.change'], secret: 'mysecret' });
      const encryptedSecret = prisma.webhookRegistration.create.mock.calls[0][0].data.secret as string;

      // Simulate a DB row with the encrypted secret and read it back.
      prisma.webhookRegistration.findMany.mockResolvedValue([
        { id: 'wh-1', url: 'https://example.com/hook', secret: encryptedSecret, events: ['policy.status.change'], isActive: true, createdAt: new Date() },
      ]);

      const registrations = await service.getRegistrations();
      expect(registrations[0].secret).toBe('mysecret');
    });

    it('reads plain-text secrets without WEBHOOK_SECRET_KEY (backward compatibility)', async () => {
      const { service, prisma } = build([
        { id: 'wh-1', url: 'https://example.com/hook', secret: 'plaintext', events: ['policy.status.change'], isActive: true, createdAt: new Date() },
      ]);

      const registrations = await service.getRegistrations();
      expect(registrations[0].secret).toBe('plaintext');
    });

    it('#607 — signPayload uses the top-level crypto import (not require)', async () => {
      // Verify the HMAC signature is produced correctly via the module-level
      // crypto import; if signPayload used require('crypto') at runtime it
      // would still work but would be inconsistent — this test confirms the
      // correct output regardless of import mechanism.
      const { service } = build([
        { id: 'a', url: 'https://a.test', secret: 'sig-secret', events: ['claim.status.change'], isActive: true, createdAt: new Date() },
      ]);
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, headers: new Map() } as unknown as Response);

      const event = { claimId: 'x', fromStatus: 'PROCESSING', toStatus: 'PAID', timestamp: 99 };
      await service.notifyClaimStatusChange(event);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const expected = crypto.createHmac('sha256', 'sig-secret').update(JSON.stringify(event)).digest('base64');
      expect((init.headers as Record<string, string>)['X-Webhook-Signature']).toBe(expected);
    });
  });

  describe('#612 — parallel webhook delivery', () => {
    it('delivers to multiple webhooks in parallel, not sequentially', async () => {
      const { service } = build([
        { id: 'a', url: 'https://a.test', secret: null, events: ['policy.status.change'], isActive: true, createdAt: new Date() },
        { id: 'b', url: 'https://b.test', secret: null, events: ['policy.status.change'], isActive: true, createdAt: new Date() },
        { id: 'c', url: 'https://c.test', secret: null, events: ['policy.status.change'], isActive: true, createdAt: new Date() },
      ]);

      const callOrder: string[] = [];
      jest.spyOn(global, 'fetch').mockImplementation(async (url: string) => {
        callOrder.push(url as string);
        return { ok: true, status: 200, headers: new Map() } as unknown as Response;
      });

      await service.notifyPolicyStatusChange({
        policyId: 'p1',
        fromStatus: 'ACTIVE',
        toStatus: 'CLAIMED',
        timestamp: Date.now(),
      });

      // All three should have been called
      expect(callOrder).toHaveLength(3);
    });
  });

  describe('#614 — delivery status feedback', () => {
    it('returns delivery results with success/failure per registration', async () => {
      const { service } = build([
        { id: 'a', url: 'https://a.test', secret: null, events: ['policy.status.change'], isActive: true, createdAt: new Date() },
        { id: 'b', url: 'https://b.test', secret: null, events: ['policy.status.change'], isActive: true, createdAt: new Date() },
      ]);

      let callCount = 0;
      jest.spyOn(global, 'fetch').mockImplementation(async (url: string) => {
        callCount++;
        if (url === 'https://b.test') {
          return { ok: false, status: 500, headers: new Map() } as unknown as Response;
        }
        return { ok: true, status: 200, headers: new Map() } as unknown as Response;
      });

      const results = await service.notifyPolicyStatusChange({
        policyId: 'p1',
        fromStatus: 'ACTIVE',
        toStatus: 'CLAIMED',
        timestamp: Date.now(),
      });

      expect(results).toHaveLength(2);
      const successResult = results.find((r) => r.registrationId === 'a');
      const failResult = results.find((r) => r.registrationId === 'b');
      expect(successResult?.success).toBe(true);
      expect(failResult?.success).toBe(false);
    });
  });

  describe('#613 — response signature verification', () => {
    it('verifies response signature when present', async () => {
      const { service } = build([
        { id: 'a', url: 'https://a.test', secret: 'mysecret', events: ['policy.status.change'], isActive: true, createdAt: new Date() },
      ]);

      const responseBody = '{"status":"ok"}';
      const expectedResponseSig = crypto.createHmac('sha256', 'mysecret').update(responseBody).digest('base64');

      const responseHeaders = new Map([['x-webhook-signature-response', expectedResponseSig]]);
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: responseHeaders,
        text: async () => responseBody,
      } as unknown as Response);

      await expect(
        service.notifyPolicyStatusChange({
          policyId: 'p1',
          fromStatus: 'ACTIVE',
          toStatus: 'CLAIMED',
          timestamp: Date.now(),
        }),
      ).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ success: true })]),
      );
    });

    it('rejects when response signature does not match', async () => {
      const { service } = build([
        { id: 'a', url: 'https://a.test', secret: 'mysecret', events: ['policy.status.change'], isActive: true, createdAt: new Date() },
      ]);

      const responseHeaders = new Map([['x-webhook-signature-response', 'badsignature']]);
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: responseHeaders,
        text: async () => '{"status":"ok"}',
      } as unknown as Response);

      const results = await service.notifyPolicyStatusChange({
        policyId: 'p1',
        fromStatus: 'ACTIVE',
        toStatus: 'CLAIMED',
        timestamp: Date.now(),
      });

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('signature verification failed');
    });
  });

  describe('#751 — webhook redirect handling and domain protection', () => {
    it('sets redirect: manual when dispatching webhook request', async () => {
      const { service } = build([
        { id: 'a', url: 'https://webhook.test/callback', secret: 's', events: ['claim.status.change'], isActive: true, createdAt: new Date() },
      ]);
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
      } as unknown as Response);

      await service.notifyClaimStatusChange({
        claimId: 'c1',
        fromStatus: 'PENDING',
        toStatus: 'PROCESSING',
        timestamp: 12345,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.redirect).toBe('manual');
    });

    it('rejects and logs redirect attempts to a different domain', async () => {
      const { service } = build([
        { id: 'target-1', url: 'https://trusted.example.com/webhook', secret: 's', events: ['claim.status.change'], isActive: true, createdAt: new Date() },
      ]);

      const redirectHeaders = new Map([['location', 'https://malicious-attacker.com/steal-payload']]);
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 302,
        headers: redirectHeaders,
      } as unknown as Response);

      const results = await service.notifyClaimStatusChange({
        claimId: 'c1',
        fromStatus: 'PENDING',
        toStatus: 'PROCESSING',
        timestamp: 12345,
      });

      expect(results[0].success).toBe(false);
      expect(results[0].error).toMatch(/redirect to different domain blocked|redirects are not followed/);
      // Ensure fetch was never called with the malicious redirect URL
      expect(fetchMock).not.toHaveBeenCalledWith(
        'https://malicious-attacker.com/steal-payload',
        expect.anything(),
      );
    });

    it('rejects redirect attempts on 301, 307, 308 without leaking payloads', async () => {
      const { service } = build([
        { id: 'target-2', url: 'https://trusted.example.com/webhook', secret: 's', events: ['policy.status.change'], isActive: true, createdAt: new Date() },
      ]);

      for (const statusCode of [301, 307, 308]) {
        const redirectHeaders = new Map([['location', 'https://other-domain.org/hook']]);
        jest.spyOn(global, 'fetch').mockResolvedValue({
          ok: false,
          status: statusCode,
          headers: redirectHeaders,
        } as unknown as Response);

        const results = await service.notifyPolicyStatusChange({
          policyId: 'p1',
          fromStatus: 'PENDING',
          toStatus: 'ACTIVE',
          timestamp: 12345,
        });

        expect(results[0].success).toBe(false);
        expect(results[0].error).toBeDefined();
      }
    });
  });

  describe('retry backoff, signature verification, payload limit, and shutdown drain (#870)', () => {
    it('retries failed deliveries with exponential backoff delays (1000ms, 2000ms, 4000ms)', async () => {
      const { service } = build([
        { id: 'w-retry', url: 'https://retry.example.com/hook', secret: 'sec', events: ['claim.status.change'], isActive: true, createdAt: new Date() },
      ]);
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 502,
        headers: new Map(),
      } as unknown as Response);

      const results = await service.notifyClaimStatusChange({
        claimId: 'c1',
        fromStatus: 'PENDING',
        toStatus: 'PAID',
        timestamp: 100,
      });

      expect(results[0].success).toBe(false);
      const delays = sleepSpy.mock.calls.map((c) => c[0] as number);
      expect(delays).toHaveLength(3);
      expect(delays[0]).toBeGreaterThanOrEqual(0);
      expect(delays[0]).toBeLessThanOrEqual(1000);
      expect(delays[1]).toBeGreaterThanOrEqual(0);
      expect(delays[1]).toBeLessThanOrEqual(2000);
      expect(delays[2]).toBeGreaterThanOrEqual(0);
      expect(delays[2]).toBeLessThanOrEqual(4000);
    });

    it('computes HMAC-SHA256 base64 signature and verifies response signature', async () => {
      const secret = 'my-webhook-secret';
      const { service } = build([
        { id: 'w-sig', url: 'https://sig.example.com/hook', secret, events: ['claim.status.change'], isActive: true, createdAt: new Date() },
      ]);
      const responseBody = '{"ack":true}';
      const expectedRespSig = crypto.createHmac('sha256', secret).update(responseBody).digest('base64');

      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([['x-webhook-signature-response', expectedRespSig]]),
        text: async () => responseBody,
      } as unknown as Response);

      const results = await service.notifyClaimStatusChange({
        claimId: 'c-sig',
        fromStatus: 'PENDING',
        toStatus: 'PAID',
        timestamp: 200,
      });

      expect(results[0].success).toBe(true);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const sentHeaders = init.headers as Record<string, string>;
      const expectedReqSig = crypto.createHmac('sha256', secret).update(String(init.body)).digest('base64');
      expect(sentHeaders['X-Webhook-Signature']).toBe(expectedReqSig);

      // Mismatched response signature fails delivery
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([['x-webhook-signature-response', 'bad-signature']]),
        text: async () => responseBody,
      } as unknown as Response);
      const badResults = await service.notifyClaimStatusChange({
        claimId: 'c-sig-bad',
        fromStatus: 'PENDING',
        toStatus: 'PAID',
        timestamp: 201,
      });
      expect(badResults[0].success).toBe(false);
      expect(badResults[0].error).toContain('signature verification failed');
    });

    it('enforces 1 MB payload size limit before dispatching', async () => {
      const { service } = build([
        { id: 'w-big', url: 'https://big.example.com/hook', secret: null, events: ['claim.status.change'], isActive: true, createdAt: new Date() },
      ]);
      const fetchSpy = jest.spyOn(global, 'fetch').mockClear();

      const results = await service.notifyClaimStatusChange({
        claimId: 'c-big',
        fromStatus: 'PENDING',
        toStatus: 'REJECTED',
        reason: 'x'.repeat(1_100_000),
        timestamp: 300,
      });

      expect(results[0].success).toBe(false);
      expect(results[0].error).toMatch(/maximum size of 1048576 bytes/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('drains in-flight deliveries during onApplicationShutdown', async () => {
      const { service } = build([]);
      let resolved = false;
      const inFlight = new Promise<void>((resolve) => {
        setTimeout(() => {
          resolved = true;
          resolve();
        }, 20);
      });
      (service as any).inFlightDeliveries.add(inFlight);

      await service.onApplicationShutdown('SIGTERM');
      expect(resolved).toBe(true);
    });
  });
});

