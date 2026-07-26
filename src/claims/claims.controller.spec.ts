import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';

describe('ClaimsController', () => {
  const WALLET = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
  const OTHER_WALLET = 'GBXY7KLMNOPQRSTUVWXYZAB2CDEFGHIJKLMNOPQRSTUVWXYZAB2CDEF';

  let controller: ClaimsController;
  let mockClaims: jest.Mocked<Pick<ClaimsService, 'submitClaim' | 'getClaimsByWallet' | 'autoProcess' | 'getClaim'>>;

  function reqWith(wallet?: string) {
    return { user: undefined, wallet } as any;
  }

  beforeEach(() => {
    mockClaims = {
      submitClaim: jest.fn(),
      getClaimsByWallet: jest.fn(),
      autoProcess: jest.fn(),
      getClaim: jest.fn(),
    };
    controller = new ClaimsController(mockClaims as unknown as ClaimsService);
  });

  describe('submitClaim', () => {
    it('submits a claim for the authenticated wallet', async () => {
      mockClaims.submitClaim.mockResolvedValue('claim-1');

      const result = await controller.submitClaim({ policyId: 'policy-1' } as any, reqWith(WALLET));

      expect(mockClaims.submitClaim).toHaveBeenCalledWith(WALLET, 'policy-1');
      expect(result).toEqual({ success: true, data: { claimId: 'claim-1' } });
    });

    it('throws Unauthorized when there is no authenticated wallet', async () => {
      await expect(controller.submitClaim({ policyId: 'policy-1' } as any, reqWith(undefined))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockClaims.submitClaim).not.toHaveBeenCalled();
    });

    it('throws Forbidden when the DTO claimant does not match the authenticated wallet', async () => {
      await expect(
        controller.submitClaim({ policyId: 'policy-1', claimant: OTHER_WALLET } as any, reqWith(WALLET)),
      ).rejects.toThrow(ForbiddenException);
      expect(mockClaims.submitClaim).not.toHaveBeenCalled();
    });
  });

  describe('getClaimsByWalletQuery', () => {
    it('returns paginated history for the authenticated wallet', async () => {
      mockClaims.getClaimsByWallet.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 } as any);

      const result = await controller.getClaimsByWalletQuery(WALLET, '1', '20', reqWith(WALLET));

      expect(mockClaims.getClaimsByWallet).toHaveBeenCalledWith(WALLET, 1, 20);
      expect(result).toMatchObject({ success: true, total: 0 });
    });

    it('throws Forbidden when the queried wallet does not match the authenticated wallet', async () => {
      await expect(
        controller.getClaimsByWalletQuery(OTHER_WALLET, undefined as any, undefined as any, reqWith(WALLET)),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('autoProcess', () => {
    it('delegates to ClaimsService.autoProcess', async () => {
      mockClaims.autoProcess.mockResolvedValue('Paid');

      const result = await controller.autoProcess('policy-1');

      expect(mockClaims.autoProcess).toHaveBeenCalledWith('policy-1');
      expect(result).toEqual({ success: true, data: { result: 'Paid' } });
    });
  });

  describe('getClaim', () => {
    it('returns the claim when it belongs to the authenticated wallet', async () => {
      mockClaims.getClaim.mockResolvedValue({ id: 'claim-1', claimant: WALLET } as any);

      const result = await controller.getClaim('claim-1', reqWith(WALLET));

      expect(result).toMatchObject({ success: true, data: { id: 'claim-1' } });
    });

    it('throws NotFound when the claim does not exist', async () => {
      mockClaims.getClaim.mockResolvedValue(null as any);

      await expect(controller.getClaim('missing', reqWith(WALLET))).rejects.toThrow(NotFoundException);
    });

    it('throws Forbidden when the claim belongs to a different wallet', async () => {
      mockClaims.getClaim.mockResolvedValue({ id: 'claim-1', claimant: OTHER_WALLET } as any);

      await expect(controller.getClaim('claim-1', reqWith(WALLET))).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getClaimHistory', () => {
    it('returns paginated history for the authenticated wallet', async () => {
      mockClaims.getClaimsByWallet.mockResolvedValue({ data: [{ id: 'c1' }], total: 1, page: 1, limit: 20 } as any);

      const result = await controller.getClaimHistory(WALLET, undefined as any, undefined as any, reqWith(WALLET));

      expect(mockClaims.getClaimsByWallet).toHaveBeenCalledWith(WALLET, 1, 20);
      expect(result).toMatchObject({ success: true, total: 1 });
    });

    it('throws Forbidden when reading claims for another wallet', async () => {
      await expect(
        controller.getClaimHistory(OTHER_WALLET, undefined as any, undefined as any, reqWith(WALLET)),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
