import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

describe('WebhooksService', () => {
  function build(rows: any[] = []) {
    const prisma = {
      webhookRegistration: {
        create: jest.fn(async ({ data }: any) => ({ id: 'wh-1', createdAt: new Date(), isActive: true, ...data })),
        findMany: jest.fn().mockResolvedValue(rows),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return { service: new WebhooksService(prisma as any), prisma };
  }

  afterEach(() => jest.restoreAllMocks());

  it('#482 — persists registrations to the database', async () => {
    const { service, prisma } = build();

    const result = await service.registerWebhook({ url: 'https://example.com/hook', events: ['claim.status.change'], secret: 's' });

    expect(result).toEqual({ id: 'wh-1', status: 'registered' });
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
});
