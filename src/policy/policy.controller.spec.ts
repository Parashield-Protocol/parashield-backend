import { Test, TestingModule } from "@nestjs/testing";
import { PolicyController } from "./policy.controller";
import { PolicyService } from "./policy.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthenticatedRequest } from "../auth/authenticated-request";
import { ForbiddenException, BadRequestException } from "@nestjs/common";

describe("PolicyController", () => {
  let controller: PolicyController;
  let service: PolicyService;

  const mockPolicyService = {
    getActiveProducts: jest.fn(),
    getUserPolicies: jest.fn(),
    getPolicy: jest.fn(),
    validateCoverage: jest.fn().mockResolvedValue({ valid: true }),
    calculatePremium: jest.fn(),
    confirmAndCreatePolicy: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PolicyController],
      providers: [
        {
          provide: PolicyService,
          useValue: mockPolicyService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PolicyController>(PolicyController);
    service = module.get<PolicyService>(PolicyService);
    jest.clearAllMocks();
  });

  describe("getMyPolicies pagination validation", () => {
    const wallet = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ";
    const mockReq = {
      user: { walletAddress: wallet },
      wallet: wallet,
    } as AuthenticatedRequest;

    const mockPoliciesResponse = {
      data: [],
      total: 50,
      page: 1,
      limit: 20,
    };

    it("should accept valid page and limit parameters", async () => {
      mockPolicyService.getUserPolicies.mockResolvedValue(mockPoliciesResponse);

      const result = await controller.getMyPolicies(wallet, "2", "50", mockReq);

      expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
        wallet,
        2,
        50,
      );
      expect(result.success).toBe(true);
    });

    describe("page parameter validation", () => {
      it("should treat page=0 as page=1", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue(
          mockPoliciesResponse,
        );

        await controller.getMyPolicies(wallet, "0", "20", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          20,
        );
      });

      it("should treat negative page as page=1", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue(
          mockPoliciesResponse,
        );

        await controller.getMyPolicies(wallet, "-5", "20", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          20,
        );
      });

      it("should handle non-integer page as page=1", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue(
          mockPoliciesResponse,
        );

        await controller.getMyPolicies(wallet, "abc", "20", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          20,
        );
      });

      it("should handle decimal page by truncating to integer", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue(
          mockPoliciesResponse,
        );

        await controller.getMyPolicies(wallet, "2.7", "20", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          2,
          20,
        );
      });
    });

    describe("limit parameter validation", () => {
      it("should treat negative limit as limit=1", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue({
          ...mockPoliciesResponse,
          limit: 1,
        });

        await controller.getMyPolicies(wallet, "1", "-5", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          1,
        );
      });

      it("should treat limit=0 as default 20", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue(
          mockPoliciesResponse,
        );

        await controller.getMyPolicies(wallet, "1", "0", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          20,
        );
      });

      it("should cap limit=999999 to 100", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue({
          ...mockPoliciesResponse,
          limit: 100,
        });

        await controller.getMyPolicies(wallet, "1", "999999", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          100,
        );
      });

      it("should cap any limit > 100 to 100", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue({
          ...mockPoliciesResponse,
          limit: 100,
        });

        await controller.getMyPolicies(wallet, "1", "500", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          100,
        );
      });

      it("should handle non-integer limit as default 20", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue(
          mockPoliciesResponse,
        );

        await controller.getMyPolicies(wallet, "1", "xyz", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          20,
        );
      });

      it("should handle decimal limit by truncating to integer", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue(
          mockPoliciesResponse,
        );

        await controller.getMyPolicies(wallet, "1", "25.9", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          25,
        );
      });
    });

    describe("default values", () => {
      it("should use page=1 and limit=20 when not provided", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue(
          mockPoliciesResponse,
        );

        await controller.getMyPolicies(
          wallet,
          undefined as any,
          undefined as any,
          mockReq,
        );

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          20,
        );
      });

      it("should use page=1 and limit=20 when empty strings provided", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue(
          mockPoliciesResponse,
        );

        await controller.getMyPolicies(wallet, "", "", mockReq);

        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          20,
        );
      });
    });

    describe("wallet authorization", () => {
      it("should throw ForbiddenException when trying to access another wallet policies", async () => {
        const otherWallet =
          "GBACDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUV";

        await expect(
          controller.getMyPolicies(otherWallet, "1", "20", mockReq),
        ).rejects.toThrow(ForbiddenException);
      });

      it("should throw BadRequestException when no wallet is available in request", async () => {
        const reqNoWallet = {
          user: { walletAddress: null },
          wallet: undefined,
        } as AuthenticatedRequest;

        await expect(
          controller.getMyPolicies(wallet, "1", "20", reqNoWallet),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe("response format", () => {
      it("should return success response with pagination metadata", async () => {
        const response = {
          data: [
            {
              id: "policy-1",
              productId: "prod-1",
              policyholder: wallet,
              coverage: "500",
              premiumPaid: "25",
              oracleKey: "rainfall:0,0:2026-06",
              startTime: 1704067200,
              endTime: 1711929600,
              status: "ACTIVE",
            },
          ],
          total: 25,
          page: 1,
          limit: 20,
        };

        mockPolicyService.getUserPolicies.mockResolvedValue(response);

        const result = await controller.getMyPolicies(
          wallet,
          "1",
          "20",
          mockReq,
        );

        expect(result.success).toBe(true);
        expect(result.data).toEqual(response.data);
        expect(result.total).toBe(25);
        expect(result.page).toBe(1);
        expect(result.limit).toBe(20);
      });
    });

    describe("DOS protection edge cases", () => {
      it("should prevent DOS from requesting huge page numbers", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue({
          ...mockPoliciesResponse,
          page: 999999999,
        });

        await controller.getMyPolicies(wallet, "999999999", "1", mockReq);

        // Service should still receive the page number and handle it safely
        // (the service would return skip=(page-1)*limit which is safe)
        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          999999999,
          1,
        );
      });

      it("should prevent DOS from requesting huge limits", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue({
          ...mockPoliciesResponse,
          limit: 100,
        });

        await controller.getMyPolicies(wallet, "1", "99999999999999", mockReq);

        // Should cap at 100
        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          100,
        );
      });

      it("should handle simultaneous extreme parameter combinations", async () => {
        mockPolicyService.getUserPolicies.mockResolvedValue({
          ...mockPoliciesResponse,
          page: 1,
          limit: 100,
        });

        await controller.getMyPolicies(
          wallet,
          "-999999",
          "999999999999999",
          mockReq,
        );

        // Should normalize to page=1, limit=100
        expect(mockPolicyService.getUserPolicies).toHaveBeenCalledWith(
          wallet,
          1,
          100,
        );
      });
    });
  });
});
