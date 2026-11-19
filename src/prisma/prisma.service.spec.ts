import { PrismaService, sanitizeConnectionError } from './prisma.service';

describe('PrismaService credential rotation, replica routing, and query cache (#871)', () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origReplicaUrl = process.env.DATABASE_REPLICA_URL;
  const origConnLimit = process.env.DATABASE_CONNECTION_LIMIT;

  afterEach(() => {
    process.env.DATABASE_URL = origDbUrl;
    if (origReplicaUrl === undefined) delete process.env.DATABASE_REPLICA_URL;
    else process.env.DATABASE_REPLICA_URL = origReplicaUrl;
    if (origConnLimit === undefined) delete process.env.DATABASE_CONNECTION_LIMIT;
    else process.env.DATABASE_CONNECTION_LIMIT = origConnLimit;
    jest.restoreAllMocks();
  });

  it('applies connection pool parameters from env vars and respects explicit URL params', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/parashield';
    process.env.DATABASE_CONNECTION_LIMIT = '25';
    const svc = new PrismaService();
    expect(svc.poolConfig.connectionLimit).toBe(25);

    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/parashield?connection_limit=7';
    const svcExplicit = new PrismaService();
    expect(svcExplicit.poolConfig.connectionLimit).toBe(7);
  });

  it('reader returns replica client when configured and falls back to primary otherwise', () => {
    delete process.env.DATABASE_REPLICA_URL;
    process.env.DATABASE_URL = 'postgresql://user:pass@primary:5432/db';
    const svcNoReplica = new PrismaService();
    expect(svcNoReplica.reader).toBe(svcNoReplica);

    process.env.DATABASE_REPLICA_URL = 'postgresql://user:pass@replica:5432/db';
    const svcWithReplica = new PrismaService();
    expect(svcWithReplica.reader).not.toBe(svcWithReplica);
  });

  it('rotateCredentials swaps clients atomically and schedules draining disconnect of retired client', async () => {
    jest.useFakeTimers();
    process.env.DATABASE_URL = 'postgresql://user:old@primary:5432/db';
    delete process.env.DATABASE_REPLICA_URL;

    const svc = new PrismaService();
    const oldClient = { $disconnect: jest.fn().mockResolvedValue(undefined) };
    const newClient = { $connect: jest.fn().mockResolvedValue(undefined), $disconnect: jest.fn().mockResolvedValue(undefined) };
    (svc as any).client = oldClient;
    jest.spyOn(svc as any, 'createClient').mockReturnValue(newClient);

    process.env.DATABASE_URL = 'postgresql://user:new@primary:5432/db';
    const rotated = await svc.rotateCredentials();

    expect(rotated).toBe(true);
    expect(newClient.$connect).toHaveBeenCalledTimes(1);
    expect((svc as any).client).toBe(newClient);

    jest.runAllTimers();
    await Promise.resolve();
    expect(oldClient.$disconnect).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('cachedQuery caches until TTL expires and supports prefix invalidation', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@primary:5432/db';
    const svc = new PrismaService();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { count: calls };
    };

    const first = await svc.cachedQuery('product:1', 60, loader);
    const second = await svc.cachedQuery('product:1', 60, loader);
    expect(first).toEqual({ count: 1 });
    expect(second).toEqual({ count: 1 });
    expect(calls).toBe(1);

    svc.invalidateCacheByPrefix('product:');
    const third = await svc.cachedQuery('product:1', 60, loader);
    expect(third).toEqual({ count: 2 });
    expect(calls).toBe(2);
  });

  it('sanitizeConnectionError redacts credentials from connection error messages', () => {
    const err = new Error('connect ECONNREFUSED postgresql://alice:supersecret@db.internal:5432/parashield');
    const sanitized = sanitizeConnectionError(err);
    expect(sanitized.message).not.toContain('supersecret');
    expect(sanitized.message).not.toContain('alice');
  });
});
