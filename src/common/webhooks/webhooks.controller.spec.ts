import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { WebhooksController } from './webhooks.controller';
import { RegisterWebhookDto, WebhookEventType } from './dto/webhook.dto';

/** Minimal in-memory storage so the guard can be exercised without Redis. */
class InMemoryThrottlerStorage implements ThrottlerStorage {
  private readonly windows = new Map<string, { count: number; start: number }>();

  async increment(key: string, ttl: number, limit: number, blockDuration: number) {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now - window.start > ttl) {
      window = { count: 0, start: now };
      this.windows.set(key, window);
    }
    window.count += 1;
    const expiredIn = window.start + ttl - now;
    const blockedIn = window.start + blockDuration - now;
    return {
      totalHits: window.count,
      timeToExpire: Math.ceil(expiredIn / 1000),
      isBlocked: window.count > limit,
      timeToBlockExpire: blockedIn > 0 ? Math.ceil(blockedIn / 1000) : 0,
    };
  }
}

describe('WebhooksController', () => {
  const body: RegisterWebhookDto = {
    url: 'https://example.com/hook',
    events: [WebhookEventType.POLICY_STATUS_CHANGE],
    secret: 's',
  };

  function build() {
    const webhooks = {
      registerWebhook: jest.fn().mockResolvedValue({ id: 'wh-1', status: 'registered' }),
      getRegistrations: jest.fn().mockResolvedValue([
        { id: 'wh-1', url: 'https://example.com/hook', secret: 'topsecret', events: [], isActive: true, createdAt: new Date() },
      ]),
    };
    const controller = new WebhooksController(webhooks as any, {} as any);
    return { controller, webhooks };
  }

  /** Guard context whose handler is the real controller method under test. */
  function contextFor(method: keyof WebhooksController, ip = '203.0.113.10'): ExecutionContext {
    const response = { header: jest.fn() };
    const handler = (WebhooksController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
    return {
      getHandler: () => handler,
      getClass: () => WebhooksController,
      switchToHttp: () => ({
        getRequest: () => ({ ip, headers: {}, socket: { remoteAddress: ip } }),
        getResponse: () => response,
      }),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  }

  /** Same wiring as AppModule: global 60 req / 60 s default, route-level overrides applied by the guard. */
  async function buildGuard(storage: ThrottlerStorage) {
    const options: ThrottlerModuleOptions = { throttlers: [{ ttl: 60000, limit: 60 }] };
    const guard = new ThrottlerGuard(options, storage, new Reflector());
    await guard.onModuleInit();
    return guard;
  }

  describe('POST /webhooks/register', () => {
    it('delegates to the service and wraps the result', async () => {
      const { controller, webhooks } = build();

      await expect(controller.register(body)).resolves.toEqual({
        success: true,
        data: { id: 'wh-1', status: 'registered' },
      });
      expect(webhooks.registerWebhook).toHaveBeenCalledWith(body);
    });

    it('is throttled to 10 registrations per 60 s', async () => {
      const guard = await buildGuard(new InMemoryThrottlerStorage());
      const context = contextFor('register');

      for (let i = 0; i < 10; i++) {
        await expect(guard.canActivate(context)).resolves.toBe(true);
      }

      let caught: unknown;
      try {
        await guard.canActivate(context);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(429);
    });

    it('keys the limit per caller IP, so other callers are unaffected', async () => {
      const guard = await buildGuard(new InMemoryThrottlerStorage());

      for (let i = 0; i < 10; i++) {
        await expect(guard.canActivate(contextFor('register', '198.51.100.7'))).resolves.toBe(true);
      }
      await expect(guard.canActivate(contextFor('register', '198.51.100.7'))).rejects.toThrow(HttpException);
      await expect(guard.canActivate(contextFor('register', '203.0.113.50'))).resolves.toBe(true);
    });

    it('overrides the app-wide 60 req / 60 s default on the register handler', () => {
      const limit = Reflect.getMetadata(`${THROTTLER_LIMIT}default`, WebhooksController.prototype.register);
      expect(limit).toBe(10);
    });
  });

  describe('GET /webhooks', () => {
    it('keeps the app-wide default limit (no tighter route override)', () => {
      const limit = Reflect.getMetadata(`${THROTTLER_LIMIT}default`, WebhooksController.prototype.list);
      expect(limit).toBeUndefined();
    });

    it('never echoes stored signing secrets', async () => {
      const { controller } = build();

      const result = await controller.list();

      expect(result).toEqual({
        success: true,
        data: [expect.not.objectContaining({ secret: expect.anything() })],
      });
    });
  });
});
