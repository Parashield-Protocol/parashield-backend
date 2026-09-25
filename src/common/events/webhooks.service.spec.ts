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
    return { service: new WebhooksService(prisma as any, config as any), prisma, config };
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
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);

    const event = { claimId: 'c1', fromStatus: 'PROCESSING', toStatus: 'PAID', timestamp: 1 };
    await service.notifyClaimStatusChange(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://a.test');
    const expected = crypto.createHmac('sha256', 'topsecret').update(JSON.stringify(event)).digest('base64');
    expect((init.headers as Record<string, string>)['X-Webhook-Signature']).toBe(expected);
  });

  it('does not reject when loading registrations fails (callers fire-and-forget)', async () => {
    const { service, prisma } = build();
    prisma.webhookRegistration.findMany.mockRejectedValue(new Error('db down'));

    await expect(
      service.notifyPolicyStatusChange({ policyId: 'p', fromStatus: 'ACTIVE', toStatus: 'CLAIMED', timestamp: 1 }),
    ).resolves.toBeUndefined();
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
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);

      const event = { claimId: 'x', fromStatus: 'PROCESSING', toStatus: 'PAID', timestamp: 99 };
      await service.notifyClaimStatusChange(event);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const expected = crypto.createHmac('sha256', 'sig-secret').update(JSON.stringify(event)).digest('base64');
      expect((init.headers as Record<string, string>)['X-Webhook-Signature']).toBe(expected);
    });
  });
});
