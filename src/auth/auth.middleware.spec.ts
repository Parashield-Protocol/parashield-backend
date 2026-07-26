import { Keypair } from '@stellar/stellar-sdk';
import { AuthMiddleware } from './auth.middleware';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthMiddleware', () => {
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const nonce = 'sign-this-nonce-please';

  function sign(message: string): string {
    return keypair.sign(Buffer.from(message, 'utf8')).toString('base64');
  }

  function requestWith(headers: Record<string, string>) {
    return { headers } as any;
  }

  function mockResponse() {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  let mockPrisma: {
    authChallenge: {
      findUnique: jest.Mock;
      delete: jest.Mock;
    };
  };
  let middleware: AuthMiddleware;

  beforeEach(() => {
    mockPrisma = {
      authChallenge: {
        findUnique: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    };
    middleware = new AuthMiddleware(mockPrisma as unknown as PrismaService);
  });

  it('passes through anonymous requests with no wallet auth headers', async () => {
    const req = requestWith({});
    const res = mockResponse();
    const next = jest.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('authenticates a valid signature against an unexpired, matching challenge', async () => {
    mockPrisma.authChallenge.findUnique.mockResolvedValue({
      nonce,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const req = requestWith({
      'x-wallet-address':   address,
      'x-wallet-message':   nonce,
      'x-wallet-signature': sign(nonce),
    });
    const res = mockResponse();
    const next = jest.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.wallet).toBe(address);
    // One-time use: the nonce must be invalidated after a successful auth.
    expect(mockPrisma.authChallenge.delete).toHaveBeenCalledWith({ where: { walletAddress: address } });
  });

  // #179/#182 — the guarantee the whole challenge/response design rests on:
  // once a nonce has been consumed (deleted), replaying the exact same
  // signed message must be rejected, not silently re-accepted.
  it('#182 — rejects a replayed signature once the nonce has been consumed', async () => {
    const req = requestWith({
      'x-wallet-address':   address,
      'x-wallet-message':   nonce,
      'x-wallet-signature': sign(nonce),
    });
    const res = mockResponse();
    const next = jest.fn();

    // First attempt: challenge still exists.
    mockPrisma.authChallenge.findUnique.mockResolvedValueOnce({
      nonce,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await middleware.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Replay: the real DB row is gone after the delete() above, so the
    // lookup now returns null — exactly what the middleware would see on
    // a genuine replay attempt.
    mockPrisma.authChallenge.findUnique.mockResolvedValueOnce(null);
    const replayRes = mockResponse();
    const replayNext = jest.fn();
    await middleware.use(requestWith({ ...req.headers }), replayRes, replayNext);

    expect(replayNext).not.toHaveBeenCalled();
    expect(replayRes.status).toHaveBeenCalledWith(401);
  });

  it('rejects a signature that does not match the stored nonce', async () => {
    mockPrisma.authChallenge.findUnique.mockResolvedValue({
      nonce,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const req = requestWith({
      'x-wallet-address':   address,
      'x-wallet-message':   'a-different-message-than-the-nonce',
      'x-wallet-signature': sign('a-different-message-than-the-nonce'),
    });
    const res = mockResponse();
    const next = jest.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects an expired challenge', async () => {
    mockPrisma.authChallenge.findUnique.mockResolvedValue({
      nonce,
      expiresAt: new Date(Date.now() - 1000),
    });

    const req = requestWith({
      'x-wallet-address':   address,
      'x-wallet-message':   nonce,
      'x-wallet-signature': sign(nonce),
    });
    const res = mockResponse();
    const next = jest.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a signature from a different keypair than the claimed address', async () => {
    mockPrisma.authChallenge.findUnique.mockResolvedValue({
      nonce,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const otherKeypair = Keypair.random();
    const req = requestWith({
      'x-wallet-address':   address,
      'x-wallet-message':   nonce,
      'x-wallet-signature': otherKeypair.sign(Buffer.from(nonce, 'utf8')).toString('base64'),
    });
    const res = mockResponse();
    const next = jest.fn();

    await middleware.use(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
