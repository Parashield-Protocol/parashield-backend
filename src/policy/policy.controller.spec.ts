import { Test, TestingModule } from "@nestjs/testing";
import { PolicyController } from "./policy.controller";
import { PolicyService } from "./policy.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthenticatedRequest } from "../auth/authenticated-request";
import { ForbiddenException, BadRequestException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

describe("PolicyController", () => {
  let controller: PolicyController;
  let service: PolicyService;

  const mockPolicyService = {
    getActiveProducts: jest.fn(),
    getUserPolicies: jest.fn(),
    getPolicy: jest.fn(),
    validateCoverage: jest.fn().mockResolvedValue({ valid: true }),
    validatePoolCapacity: jest.fn(),
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

  // #246 — GET /policies/:id previously had no guard and no ownership check,
  // leaking full policy details (policyholder address, coverage, premium,
  // oracle key) to any unauthenticated caller who guessed a UUID.
  describe("#246 — getPolicy (GET /policies/:id)", () => {
    const OWNER   = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ";
    const STRANGER = "GBSTRANGERWALLET00000000000000000000000000000000000000000";
    const POLICY_ID = "policy-uuid-1234";

    const MOCK_POLICY = {
      id:           POLICY_ID,
      productId:    "prod-1",
      policyholder: OWNER,
      coverage:     "500.0000000",
      premiumPaid:  "25.0000000",
      oracleKey:    "rainfall:0,0:2026-06",
      startTime:    1704067200,
      endTime:      1711929600,
      status:       "ACTIVE",
    };

    const ownerReq = {
      user: { walletAddress: OWNER },
      wallet: OWNER,
    } as AuthenticatedRequest;

    const strangerReq = {
      user: { walletAddress: STRANGER },
      wallet: STRANGER,
    } as AuthenticatedRequest;

    it("returns the policy when the authenticated wallet is the owner", async () => {
      mockPolicyService.getPolicy.mockResolvedValue(MOCK_POLICY);

      const result = await controller.getPolicy(POLICY_ID, ownerReq);

      expect(result).toEqual({ success: true, data: MOCK_POLICY });
      expect(mockPolicyService.getPolicy).toHaveBeenCalledWith(POLICY_ID);
    });

    it("#246 — throws ForbiddenException when the authenticated wallet does not own the policy", async () => {
      mockPolicyService.getPolicy.mockResolvedValue(MOCK_POLICY);

      await expect(controller.getPolicy(POLICY_ID, strangerReq)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(controller.getPolicy(POLICY_ID, strangerReq)).rejects.toThrow(
        "Policy belongs to a different wallet",
      );
    });

    it("#246 — throws NotFoundException when the policy does not exist", async () => {
      mockPolicyService.getPolicy.mockResolvedValue(null);

      await expect(controller.getPolicy("nonexistent-id", ownerReq)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("#246 — JwtAuthGuard is registered on the getPolicy handler", () => {
      // Reflector reads the guard metadata set by @UseGuards(JwtAuthGuard).
      // If the decorator were missing, getMetadata returns undefined/empty.
      const reflector = new Reflector();
      const guards = reflector.get<unknown[]>("__guards__", controller.getPolicy);
      expect(guards).toBeDefined();
      expect(guards).toContain(JwtAuthGuard);
    });

    it("#246 — a stranger cannot read sensitive fields from another wallet's policy", async () => {
      mockPolicyService.getPolicy.mockResolvedValue(MOCK_POLICY);

      // Must reject before any data is returned to the caller
      await expect(controller.getPolicy(POLICY_ID, strangerReq)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("getProducts (GET /products)", () => {
    const MOCK_PRODUCTS = [
      {
        id: "prod-1", name: "Crop Insurance", category: "crop",
        triggerType: "rainfall", threshold: "100", comparison: "lte",
        coverageMin: "100", coverageMax: "10000", premiumRate: 500,
        maxDuration: 365, status: "ACTIVE",
      },
    ];

    it("returns a list of active products", async () => {
      mockPolicyService.getActiveProducts.mockResolvedValue(MOCK_PRODUCTS);

      const result = await controller.getProducts();

      expect(mockPolicyService.getActiveProducts).toHaveBeenCalled();
      expect(result).toEqual({ success: true, data: MOCK_PRODUCTS });
    });

    it("returns an empty array when no products are active", async () => {
      mockPolicyService.getActiveProducts.mockResolvedValue([]);

      const result = await controller.getProducts();

      expect(result).toEqual({ success: true, data: [] });
    });

    it("has no auth guard registered (public endpoint)", () => {
      const reflector = new Reflector();
      const guards = reflector.get<unknown[]>("__guards__", controller.getProducts);
      expect(guards).toBeUndefined();
    });
  });

  describe("buyPolicy (POST /policies/buy)", () => {
    const WALLET = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ";

    const VALID_DTO = {
      productId: "prod-1",
      coverageXlm: 500,
      walletAddress: WALLET,
      duration: 90,
      oracleKey: "rainfall:-0.0917,34.7679:2026-06",
    };

    const MOCK_PRODUCT = {
      id: "prod-1", name: "Crop Insurance", category: "crop",
      triggerType: "rainfall", threshold: "100", comparison: "lte",
      coverageMin: "10", coverageMax: "10000", premiumRate: 500,
      maxDuration: 365, status: "ACTIVE",
    };

    const ownerReq = {
      user: { walletAddress: WALLET },
      wallet: WALLET,
    } as AuthenticatedRequest;

    beforeEach(() => {
      mockPolicyService.getActiveProducts.mockResolvedValue([MOCK_PRODUCT]);
      mockPolicyService.validateCoverage.mockResolvedValue({ valid: true });
      mockPolicyService.validatePoolCapacity.mockResolvedValue(undefined);
      mockPolicyService.calculatePremium.mockReturnValue(75);
    });

    it("returns a premium quote when all inputs are valid", async () => {
      const result = await controller.buyPolicy(ownerReq, VALID_DTO);

      expect(mockPolicyService.getActiveProducts).toHaveBeenCalled();
      expect(mockPolicyService.validateCoverage).toHaveBeenCalledWith(
        500, MOCK_PRODUCT, VALID_DTO.oracleKey,
      );
      expect(mockPolicyService.calculatePremium).toHaveBeenCalledWith(500, 500, 90);
      expect(result).toEqual({
        success: true,
        data: {
          quote: {
            productId: "prod-1",
            productName: "Crop Insurance",
            coverageXlm: 500,
            premiumXlm: 75,
            duration: 90,
            wallet: WALLET,
          },
        },
      });
    });

    it("throws ForbiddenException when wallet address does not match authenticated user", async () => {
      const dto = { ...VALID_DTO, walletAddress: "GOTHERWALLET0000000000000000000000000000000000" };

      await expect(controller.buyPolicy(ownerReq, dto)).rejects.toThrow(ForbiddenException);
      expect(mockPolicyService.getActiveProducts).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when product is not found or inactive", async () => {
      mockPolicyService.getActiveProducts.mockResolvedValue([]);

      await expect(controller.buyPolicy(ownerReq, VALID_DTO)).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when coverage validation fails", async () => {
      mockPolicyService.validateCoverage.mockResolvedValue({ valid: false, reason: "Coverage exceeds max" });

      await expect(controller.buyPolicy(ownerReq, VALID_DTO)).rejects.toThrow(BadRequestException);
    });

    it("has JwtAuthGuard registered", () => {
      const reflector = new Reflector();
      const guards = reflector.get<unknown[]>("__guards__", controller.buyPolicy);
      expect(guards).toBeDefined();
      expect(guards).toContain(JwtAuthGuard);
    });
  });

  describe("confirmPolicy (POST /policies/confirm)", () => {
    const WALLET = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ";

    const VALID_DTO = {
      signedXdr: "AAAAAgAAA...",
      productId: "prod-1",
      coverageXlm: 500,
      walletAddress: WALLET,
      duration: 90,
      oracleKey: "rainfall:-0.0917,34.7679:2026-06",
    };

    const ownerReq = {
      user: { walletAddress: WALLET },
      wallet: WALLET,
    } as AuthenticatedRequest;

    const MOCK_RESULT = { policyId: "policy-uuid-5678", txHash: "abc123def456" };

    it("confirms and creates a policy successfully", async () => {
      mockPolicyService.confirmAndCreatePolicy.mockResolvedValue(MOCK_RESULT);

      const result = await controller.confirmPolicy(VALID_DTO, ownerReq);

      expect(mockPolicyService.confirmAndCreatePolicy).toHaveBeenCalledWith(VALID_DTO, WALLET);
      expect(result).toEqual({ success: true, data: MOCK_RESULT });
    });

    it("throws ForbiddenException when wallet address does not match authenticated user", async () => {
      const dto = { ...VALID_DTO, walletAddress: "GOTHERWALLET0000000000000000000000000000000000" };

      await expect(controller.confirmPolicy(dto, ownerReq)).rejects.toThrow(ForbiddenException);
      expect(mockPolicyService.confirmAndCreatePolicy).not.toHaveBeenCalled();
    });

    it("throws UnauthorizedException when no authenticated wallet is present", async () => {
      const reqNoWallet = {
        user: { walletAddress: null },
        wallet: undefined,
      } as AuthenticatedRequest;

      await expect(controller.confirmPolicy(VALID_DTO, reqNoWallet)).rejects.toThrow(UnauthorizedException);
      expect(mockPolicyService.confirmAndCreatePolicy).not.toHaveBeenCalled();
    });

    it("has JwtAuthGuard registered", () => {
      const reflector = new Reflector();
      const guards = reflector.get<unknown[]>("__guards__", controller.confirmPolicy);
      expect(guards).toBeDefined();
      expect(guards).toContain(JwtAuthGuard);
    });
  });
});
