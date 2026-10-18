import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { JwtService } from './jwt.service';
import { PrismaService } from '../prisma/prisma.service';
import { Keypair } from '@stellar/stellar-sdk';

describe('AuthController', () => {
  let controller: AuthController;

  const mockJwtService = {
    sign: jest.fn().mockReturnValue('mock-jwt-token'),
    expiresIn: '7d',
  };

  const mockPrismaService = {
    authChallenge: {
      findUnique: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  // In-memory Redis simulation supporting TTL, GETDEL, and Lua atomicity
  let redisStore = new Map<string, { value: string; expiresAt: number }>();

  const mockRedis = {
    set: jest.fn(async (key: string, value: string, mode?: string, ttlSeconds?: number) => {
      const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : Infinity;
      redisStore.set(key, { value, expiresAt });
      return 'OK';
    }),
    get: jest.fn(async (key: string) => {
      const item = redisStore.get(key);
      if (!item) return null;
      if (Date.now() > item.expiresAt) {
        redisStore.delete(key);
        return null;
      }
      return item.value;
    }),
    getdel: jest.fn(async (key: string) => {
      const item = redisStore.get(key);
      if (!item) return null;
      redisStore.delete(key);
      if (Date.now() > item.expiresAt) {
        return null;
      }
      return item.value;
    }),
    eval: jest.fn(async (script: string, numKeys: number, key: string) => {
      const item = redisStore.get(key);
      if (!item) return null;
      redisStore.delete(key);
      if (Date.now() > item.expiresAt) {
        return null;
      }
      return item.value;
    }),
    del: jest.fn(async (key: string) => {
      const existed = redisStore.delete(key);
      return existed ? 1 : 0;
    }),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'AUTH_NONCE_TTL_SECONDS') return '300';
      return undefined;
    }),
  };

  const keypair = Keypair.random();
  const walletAddress = keypair.publicKey();

  beforeEach(async () => {
    redisStore.clear();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: JwtService, useValue: mockJwtService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  describe('GET /auth/challenge', () => {
    it('should generate a 64-character hex nonce and store it in Redis with TTL', async () => {
      const response = await controller.getChallenge(walletAddress);

      expect(response.success).toBe(true);
      expect(response.data).toHaveLength(64); // 32 bytes in hex = 64 chars
      expect(mockRedis.set).toHaveBeenCalledWith(
        `auth:nonce:${walletAddress}`,
        response.data,
        'EX',
        300,
      );
    });

    it('should respect custom AUTH_NONCE_TTL_SECONDS configuration', async () => {
      mockConfigService.get.mockReturnValueOnce('600');
      const response = await controller.getChallenge(walletAddress);

      expect(response.success).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        `auth:nonce:${walletAddress}`,
        response.data,
        'EX',
        600,
      );
    });

    it('should throw BadRequestException for invalid wallet address', async () => {
      await expect(controller.getChallenge('invalid-wallet')).rejects.toThrow(BadRequestException);
    });
  });

  describe('POST /auth/login', () => {
    it('valid login succeeds once and consumes the nonce atomically', async () => {
      const challenge = await controller.getChallenge(walletAddress);
      const nonce = challenge.data;

      const messageBytes = Buffer.from(nonce, 'utf8');
      const signature = keypair.sign(messageBytes).toString('base64');

      const result = await controller.login({
        walletAddress,
        signature,
        message: nonce,
      });

      expect(result.success).toBe(true);
      expect(result.data.token).toBe('mock-jwt-token');
      expect(result.data.walletAddress).toBe(walletAddress);
      expect(mockRedis.getdel).toHaveBeenCalledWith(`auth:nonce:${walletAddress}`);

      // Nonce is now consumed in Redis
      expect(redisStore.has(`auth:nonce:${walletAddress}`)).toBe(false);
    });

    it('replay of the same signature fails with generic 401', async () => {
      const challenge = await controller.getChallenge(walletAddress);
      const nonce = challenge.data;

      const messageBytes = Buffer.from(nonce, 'utf8');
      const signature = keypair.sign(messageBytes).toString('base64');

      // First login succeeds
      const result = await controller.login({
        walletAddress,
        signature,
        message: nonce,
      });
      expect(result.success).toBe(true);

      // Second login replay fails with generic 401
      await expect(
        controller.login({
          walletAddress,
          signature,
          message: nonce,
        }),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        controller.login({
          walletAddress,
          signature,
          message: nonce,
        }),
      ).rejects.toThrow('Invalid or expired authentication challenge');
    });

    it('expired nonce fails with generic 401 (tested via fake timers / TTL expiry)', async () => {
      jest.useFakeTimers();
      try {
        const challenge = await controller.getChallenge(walletAddress);
        const nonce = challenge.data;

        const messageBytes = Buffer.from(nonce, 'utf8');
        const signature = keypair.sign(messageBytes).toString('base64');

        // Advance time past the 5-minute (300s) TTL
        jest.advanceTimersByTime(301 * 1000);

        await expect(
          controller.login({
            walletAddress,
            signature,
            message: nonce,
          }),
        ).rejects.toThrow(UnauthorizedException);

        await expect(
          controller.login({
            walletAddress,
            signature,
            message: nonce,
          }),
        ).rejects.toThrow('Invalid or expired authentication challenge');
      } finally {
        jest.useRealTimers();
      }
    });

    it('nonce issued to address A cannot be used for address B', async () => {
      const keypairB = Keypair.random();
      const walletB = keypairB.publicKey();

      // Issue challenge to wallet A
      const challengeA = await controller.getChallenge(walletAddress);
      const nonceA = challengeA.data;

      // Sign nonceA with wallet B's keypair
      const messageBytes = Buffer.from(nonceA, 'utf8');
      const signatureB = keypairB.sign(messageBytes).toString('base64');

      // Attempt to login as wallet B using nonceA
      await expect(
        controller.login({
          walletAddress: walletB,
          signature: signatureB,
          message: nonceA,
        }),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        controller.login({
          walletAddress: walletB,
          signature: signatureB,
          message: nonceA,
        }),
      ).rejects.toThrow('Invalid or expired authentication challenge');
    });

    it('concurrent double-submit yields exactly one success', async () => {
      const challenge = await controller.getChallenge(walletAddress);
      const nonce = challenge.data;

      const messageBytes = Buffer.from(nonce, 'utf8');
      const signature = keypair.sign(messageBytes).toString('base64');

      const loginPayload = {
        walletAddress,
        signature,
        message: nonce,
      };

      // Two concurrent login requests with identical valid signature and nonce
      const [res1, res2] = await Promise.allSettled([
        controller.login(loginPayload),
        controller.login(loginPayload),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      if (rejected[0].status === 'rejected') {
        expect(rejected[0].reason).toBeInstanceOf(UnauthorizedException);
        expect((rejected[0].reason as Error).message).toBe(
          'Invalid or expired authentication challenge',
        );
      }
    });

    it('failed verification consumes the nonce so it cannot be retried (safer)', async () => {
      const challenge = await controller.getChallenge(walletAddress);
      const nonce = challenge.data;

      // Bad signature attempt
      const badSignature = Buffer.from('invalid-signature').toString('base64');
      await expect(
        controller.login({
          walletAddress,
          signature: badSignature,
          message: nonce,
        }),
      ).rejects.toThrow(UnauthorizedException);

      // Now attempt valid signature with the same nonce — should FAIL because nonce was consumed
      const validMessageBytes = Buffer.from(nonce, 'utf8');
      const validSignature = keypair.sign(validMessageBytes).toString('base64');

      await expect(
        controller.login({
          walletAddress,
          signature: validSignature,
          message: nonce,
        }),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        controller.login({
          walletAddress,
          signature: validSignature,
          message: nonce,
        }),
      ).rejects.toThrow('Invalid or expired authentication challenge');
    });

    it('constant-time comparison rejects mismatching message with generic 401', async () => {
      const challenge = await controller.getChallenge(walletAddress);
      const nonce = challenge.data;
      const mismatchedMessage = 'b'.repeat(64);

      const messageBytes = Buffer.from(mismatchedMessage, 'utf8');
      const signature = keypair.sign(messageBytes).toString('base64');

      await expect(
        controller.login({
          walletAddress,
          signature,
          message: mismatchedMessage,
        }),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        controller.login({
          walletAddress,
          signature,
          message: mismatchedMessage,
        }),
      ).rejects.toThrow('Invalid or expired authentication challenge');
    });

    it('rejects malformed wallet address with generic 401 on login', async () => {
      await expect(
        controller.login({
          walletAddress: 'bad-addr',
          signature: 'sig',
          message: 'nonce',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
