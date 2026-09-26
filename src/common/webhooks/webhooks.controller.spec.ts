import { WebhooksController } from './webhooks.controller';

describe('WebhooksController', () => {
  it('returns and exposes the registered webhook ID', async () => {
    const webhooks = {
      registerWebhook: jest.fn().mockResolvedValue({
        id: 'webhook-1',
        status: 'registered',
      }),
    };
    const response = { setHeader: jest.fn() };
    const controller = new WebhooksController(webhooks as any, {} as any);

    await expect(controller.register({
      url: 'https://example.com/webhook',
      events: [],
    }, response as any)).resolves.toEqual({
      success: true,
      data: { id: 'webhook-1', status: 'registered' },
    });

    expect(response.setHeader).toHaveBeenCalledWith('X-Webhook-Id', 'webhook-1');
  });
});