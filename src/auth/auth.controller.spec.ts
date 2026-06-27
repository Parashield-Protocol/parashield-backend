import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
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
      upsert:     jest.fn(),
      delete:     jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  // Generate keypair for tests
  const keypair = Keypair.random();
  const walletAddress = keypair.publicKey();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: JwtService,    useValue: mockJwtService },
        { provide: PrismaService,  useValue: mockPrismaService },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    jest.clearAllMocks();
  });

  describe('GET /auth/challenge', () => {
    it('should generate a 64-character hex nonce and store it', async () => {
      mockPrismaService.authChallenge.upsert.mockResolvedValue({
        walletAddress,
        nonce: 'mocknonce',
      });

      const response = await controller.getChallenge(walletAddress);

      expect(response.success).toBe(true);
      expect(response.data).toHaveLength(64); // 32 bytes in hex = 64 chars
      expect(mockPrismaService.authChallenge.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { walletAddress },
          create: expect.objectContaining({
            walletAddress,
            nonce: response.data,
            expiresAt: expect.any(Date),
          }),
        }),
      );
    });

    it('should throw UnauthorizedException for an invalid wallet address format', async () => {
      await expect(controller.getChallenge('invalid-wallet')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('POST /auth/login', () => {
    it('should login successfully when signature matches the stored nonce', async () => {
      const nonce = 'a'.repeat(64);
      const messageBytes = Buffer.from(nonce, 'utf8');
      const signature = keypair.sign(messageBytes).toString('base64');

      mockPrismaService.authChallenge.findUnique.mockResolvedValue({
        walletAddress,
        nonce,
        expiresAt: new Date(Date.now() + 60000), // future expiry
      });
      mockPrismaService.authChallenge.delete.mockResolvedValue({});

      const result = await controller.login({
        walletAddress,
        signature,
        message: nonce,
      });

      expect(result.success).toBe(true);
      expect(result.data.token).toBe('mock-jwt-token');
      expect(result.data.walletAddress).toBe(walletAddress);
      expect(result.data.expiresIn).toBe(mockJwtService.expiresIn);
      expect(mockPrismaService.authChallenge.delete).toHaveBeenCalledWith({
        where: { walletAddress },
      });
    });

    it('should throw UnauthorizedException if no challenge exists for the wallet', async () => {
      mockPrismaService.authChallenge.findUnique.mockResolvedValue(null);

      await expect(
        controller.login({
          walletAddress,
          signature: 'mismatch-signature',
          message: 'nonce',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException and delete challenge if challenge has expired', async () => {
      const nonce = 'a'.repeat(64);
      mockPrismaService.authChallenge.findUnique.mockResolvedValue({
        walletAddress,
        nonce,
        expiresAt: new Date(Date.now() - 1000), // expired 1s ago
      });
      mockPrismaService.authChallenge.delete.mockResolvedValue({});

      await expect(
        controller.login({
          walletAddress,
          signature: 'sig',
          message: nonce,
        }),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrismaService.authChallenge.delete).toHaveBeenCalledWith({
        where: { walletAddress },
      });
    });

    it('should throw UnauthorizedException if the message does not match the stored challenge nonce', async () => {
      const storedNonce = 'a'.repeat(64);
      const userMessage = 'b'.repeat(64);

      mockPrismaService.authChallenge.findUnique.mockResolvedValue({
        walletAddress,
        nonce: storedNonce,
        expiresAt: new Date(Date.now() + 60000),
      });

      await expect(
        controller.login({
          walletAddress,
          signature: 'sig',
          message: userMessage,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if signature verification fails', async () => {
      const nonce = 'a'.repeat(64);
      mockPrismaService.authChallenge.findUnique.mockResolvedValue({
        walletAddress,
        nonce,
        expiresAt: new Date(Date.now() + 60000),
      });
      mockPrismaService.authChallenge.delete.mockResolvedValue({});

      await expect(
        controller.login({
          walletAddress,
          signature: Buffer.from('invalid-sig').toString('base64'),
          message: nonce,
        }),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrismaService.authChallenge.delete).not.toHaveBeenCalled();
    });
  });
});
