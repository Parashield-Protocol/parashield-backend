import { Test, TestingModule } from "@nestjs/testing";
import { PolicyService, ProductSummary, OracleKeyValidationResult } from "./policy.service";
import { StellarService } from "../stellar/stellar.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { ConflictException, GoneException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  TransactionBuilder,
  Keypair,
  Operation,
  Asset,
  Account,
  nativeToScVal,
  StrKey,
} from "@stellar/stellar-sdk";

describe("PolicyService.calculatePremium", () => {
  let service: PolicyService;

  const mockStellarService = {
    simulateInvoke: jest.fn(),
    simulateAssembleAndSend: jest.fn(),
    keeperKeypair: { publicKey: jest.fn().mockReturnValue("GABC") },
    networkPassphrase: "Test SDF Network ; September 2015",
  };

  const mockPrismaService = {
    policy: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    product: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn<string | undefined, [string]>((key: string) => {
      if (key === "POLICY_ENGINE_CONTRACT")
        return "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
      if (key === "USDC_CONTRACT")
        return "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
      return undefined;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyService,
        { provide: StellarService, useValue: mockStellarService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<PolicyService>(PolicyService);
    jest.clearAllMocks();
    mockPrismaService.policy.aggregate.mockResolvedValue({ _sum: { coverageXlm: null } });
    // Default: pool balance simulation returns null retval => Infinity (no cap)
    mockStellarService.simulateInvoke.mockResolvedValue({
      result: { retval: null },
    });
  });

  it("should return the correct premium for standard coverage", () => {
    // coverage=1000, rate=500 (5%), duration=30 days
    // expected = Math.ceil(1000 * 500 * 30 / (10000 * 30)) = Math.ceil(50) = 50
    const premium = service.calculatePremium(1000, 500, 30);
    expect(premium).toBe(50);
  });

  it("should return the same premium regardless of duration", () => {
    const premium1 = service.calculatePremium(1000, 500, 30);
    const premium2 = service.calculatePremium(1000, 500, 30);
    expect(premium1).toBe(premium2);
  });

  it("should always return a positive integer", () => {
    const testCases = [
      [10, 100],
      [500, 200],
      [100000, 500],
      [10, 500],
    ] as const;

    for (const [coverage, rate] of testCases) {
      const premium = service.calculatePremium(coverage, rate, 30);
      expect(premium).toBeGreaterThan(0);
      expect(Number.isInteger(premium)).toBe(true);
    }
  });

  describe("validateCoverage", () => {
    const product: ProductSummary = {
      id: "1",
      name: "Test Product",
      category: "crop",
      triggerType: "Threshold",
      threshold: "50.0000000",
      comparison: "LessThan",
      coverageMin: "10.0000000",
      coverageMax: "1000.0000000",
      premiumRate: 500,
      maxDuration: 365,
      status: "Active",
    };

    beforeEach(() => {
      // Pool simulation returns null retval => Infinity (no cap)
      mockStellarService.simulateInvoke.mockResolvedValue({ result: { retval: null } });
    });

    it("should return valid for coverage within range", async () => {
      const result = await service.validateCoverage(500, product);
      expect(result.valid).toBe(true);
    });

    it("should return invalid for coverage below minimum", async () => {
      const result = await service.validateCoverage(5, product);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("below the minimum");
    });

    it("should return invalid for coverage above maximum", async () => {
      const result = await service.validateCoverage(5000, product);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("exceeds the maximum");
    });

    it("should return invalid when coverage exceeds pool liquidity (#131)", async () => {
      // Simulate pool returning 100 (e.g., 100 USDC in fixed point)
      const { scValToNative } = jest.requireActual("@stellar/stellar-sdk") as any;
      // We can't easily round-trip a real ScVal in unit tests, so we stub
      // getPoolAvailableBalance directly
      jest.spyOn(service, "getPoolAvailableBalance").mockResolvedValue(100);

      const result = await service.validateCoverage(101, product);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("pool\'s available liquidity");
    });

    it("should reject an invalid oracleKey for crop products when provided (#132)", async () => {
      const result = await service.validateCoverage(500, product, "invalid-key");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("oracleKey format");
    });

    it("should accept a valid crop oracleKey when provided", async () => {
      const result = await service.validateCoverage(500, product, "rainfall:-0.0917,34.7679:2026-06");
      expect(result.valid).toBe(true);
    });
  });

  describe("validateOracleKey", () => {
    const cropProduct: ProductSummary = {
      id: "1", name: "Crop", category: "crop", triggerType: "Threshold",
      threshold: "50", comparison: "LessThan", coverageMin: "10",
      coverageMax: "1000", premiumRate: 500, maxDuration: 365, status: "Active",
    };
    const flightProduct: ProductSummary = {
      ...cropProduct, category: "flight",
    };

    it("should pass a valid crop oracleKey", () => {
      const result = service.validateOracleKey("rainfall:-0.0917,34.7679:2026-06", cropProduct);
      expect(result.valid).toBe(true);
    });

    it("should fail an invalid crop oracleKey (#132)", () => {
      const result = service.validateOracleKey("invalid-key", cropProduct);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("rainfall:lat,lng:YYYY-MM");
    });

    it("should pass a valid flight oracleKey", () => {
      const result = service.validateOracleKey("flight:KQ100:2026-06-28", flightProduct);
      expect(result.valid).toBe(true);
    });

    it("should fail an invalid flight oracleKey (#132)", () => {
      const result = service.validateOracleKey("flight:KQ100:2026-06", flightProduct);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("flight:flightNumber:YYYY-MM-DD");
    });
  });

  describe("validatePoolCapacity", () => {
    it("skips check when POOL_CAPACITY_XLM is not configured", async () => {
      mockConfigService.get.mockReturnValue(undefined);
      await expect(service.validatePoolCapacity(999999)).resolves.toBeUndefined();
      expect(mockPrismaService.policy.aggregate).not.toHaveBeenCalled();
    });

    it("skips check when POOL_CAPACITY_XLM is zero", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "POOL_CAPACITY_XLM") return "0";
        return undefined;
      });
      await expect(service.validatePoolCapacity(100)).resolves.toBeUndefined();
      expect(mockPrismaService.policy.aggregate).not.toHaveBeenCalled();
    });

    it("allows coverage when committed + requested is within pool capacity", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "POOL_CAPACITY_XLM") return "1000";
        if (key === "POLICY_ENGINE_CONTRACT") return "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
        return undefined;
      });
      mockPrismaService.policy.aggregate.mockResolvedValue({
        _sum: { coverageXlm: new (require("@prisma/client").Prisma.Decimal)("600") },
      });

      await expect(service.validatePoolCapacity(300)).resolves.toBeUndefined();
    });

    it("throws 400 when requested coverage exceeds available pool capacity", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "POOL_CAPACITY_XLM") return "1000";
        if (key === "POLICY_ENGINE_CONTRACT") return "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
        return undefined;
      });
      mockPrismaService.policy.aggregate.mockResolvedValue({
        _sum: { coverageXlm: new (require("@prisma/client").Prisma.Decimal)("800") },
      });

      await expect(service.validatePoolCapacity(300)).rejects.toThrow(
        /exceeds available pool capacity/,
      );
    });

    it("throws 400 when there is no capacity at all (pool is full)", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "POOL_CAPACITY_XLM") return "500";
        if (key === "POLICY_ENGINE_CONTRACT") return "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
        return undefined;
      });
      mockPrismaService.policy.aggregate.mockResolvedValue({
        _sum: { coverageXlm: new (require("@prisma/client").Prisma.Decimal)("500") },
      });

      await expect(service.validatePoolCapacity(1)).rejects.toThrow(
        /exceeds available pool capacity/,
      );
    });
  });

  describe("getActiveProducts", () => {
    it("should fetch active products from the database", async () => {
      mockPrismaService.product.findMany.mockResolvedValue([
        {
          id: "1",
          name: "Crop Product",
          category: "crop",
          triggerType: "Threshold",
          threshold: "50.0",
          comparison: "LessThan",
          coverageMin: "10.0",
          coverageMax: "1000.0",
          premiumRate: 500,
          maxDuration: 365,
          status: "Active",
        },
      ]);

      const products = await service.getActiveProducts();
      expect(products).toHaveLength(1);
      expect(products[0].name).toBe("Crop Product");
      expect(mockPrismaService.product.findMany).toHaveBeenCalledWith({
        where: { status: "Active" },
      });
    });
  });

  describe("createPolicy", () => {
    const validCropProduct = {
      id: "1",
      name: "Crop Product",
      category: "crop",
      triggerType: "Threshold",
      threshold: "50.0",
      comparison: "LessThan",
      coverageMin: "10.0",
      coverageMax: "1000.0",
      premiumRate: 500,
      maxDuration: 365,
      status: "Active",
    };

    beforeEach(() => {
      // Pool has infinite capacity by default in createPolicy tests
      jest.spyOn(service, "getPoolAvailableBalance").mockResolvedValue(Infinity);
    });

    it("should successfully create policy with a valid crop oracleKey", async () => {
      mockPrismaService.product.findMany.mockResolvedValue([validCropProduct]);
      mockPrismaService.policy.create.mockResolvedValue({ id: "policy-1" });

      const dto = {
        productId: "1",
        coverageXlm: 500,
        walletAddress:
          "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ",
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      const policy = await service.createPolicy(dto, "tx-hash-123");
      expect(policy.id).toBe("policy-1");
      expect(mockPrismaService.policy.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "1",
            oracleKey: "rainfall:-0.0917,34.7679:2026-06",
          }),
        }),
      );
    });

    it("should throw BadRequestException if product does not exist", async () => {
      mockPrismaService.product.findMany.mockResolvedValue([]);

      const dto = {
        productId: "nonexistent",
        coverageXlm: 500,
        walletAddress:
          "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ",
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      await expect(service.createPolicy(dto, "tx-hash")).rejects.toThrow(
        /Product with ID nonexistent not found or inactive/,
      );
    });

    it("should throw BadRequestException for invalid crop oracleKey format", async () => {
      mockPrismaService.product.findMany.mockResolvedValue([validCropProduct]);

      const dto = {
        productId: "1",
        coverageXlm: 500,
        walletAddress:
          "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ",
        duration: 90,
        oracleKey: "invalid-crop-key",
      };

      await expect(service.createPolicy(dto, "tx-hash")).rejects.toThrow(
        /oracleKey format must be rainfall:lat,lng:YYYY-MM for crop products/,
      );
    });

    it("throws ConflictException (409) on duplicate policy (P2002)", async () => {
      mockPrismaService.product.findMany.mockResolvedValue([validCropProduct]);

      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        { code: "P2002", clientVersion: "5.0.0", meta: {}, batchRequestIdx: undefined },
      );
      mockPrismaService.policy.create.mockRejectedValue(p2002Error);

      const dto = {
        productId: "1",
        coverageXlm: 500,
        walletAddress:
          "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ",
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      await expect(service.createPolicy(dto, "tx-hash")).rejects.toThrow(ConflictException);
      await expect(service.createPolicy(dto, "tx-hash")).rejects.toThrow(
        /already exists for this wallet/,
      );
    });

    it("re-throws non-P2002 database errors as-is", async () => {
      mockPrismaService.product.findMany.mockResolvedValue([validCropProduct]);

      const dbError = new Error("Connection lost");
      mockPrismaService.policy.create.mockRejectedValue(dbError);

      const dto = {
        productId: "1",
        coverageXlm: 500,
        walletAddress:
          "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ",
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      await expect(service.createPolicy(dto, "tx-hash")).rejects.toThrow("Connection lost");
    });

    it("throws ConflictException with txHash message when P2002 target is txHash (issue #137)", async () => {
      mockPrismaService.product.findMany.mockResolvedValue([validCropProduct]);

      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`txHash`)",
        { code: "P2002", clientVersion: "5.0.0", meta: { target: ["txHash"] }, batchRequestIdx: undefined },
      );
      mockPrismaService.policy.create.mockRejectedValue(p2002Error);

      const dto = {
        productId: "1",
        coverageXlm: 500,
        walletAddress: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ",
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      await expect(service.createPolicy(dto, "duplicate-tx-abc")).rejects.toThrow(
        /duplicate-tx-abc.*already been used to create a policy/,
      );
    });
  });

  describe("calculatePremium — BigInt arithmetic (issue #139)", () => {
    it("returns the same result as float for exact multiples", () => {
      // coverage=1000, rate=500, duration=30 → 1000*500*30 / 300000 = 50 exactly
      expect(service.calculatePremium(1000, 500, 30)).toBe(50);
    });

    it("rounds up when result is not a whole number", () => {
      // coverage=10, rate=100, duration=30 → 10*100*30 / 300000 = 0.1 → ceil = 1
      expect(service.calculatePremium(10, 100, 30)).toBe(1);
    });

    it("does not accumulate floating-point error on large coverage", () => {
      // Verify the BigInt path gives the exact integer result.
      // coverage=999999999, rate=9999, duration=365
      // numerator = 999999999 * 9999 * 365 = 3649635 * 999999999 = 3649631350364365
      // floored = 3649631350364365 / 300000 = 12165437834 remainder 164365 → ceil = 12165437835
      const result = service.calculatePremium(999999999, 9999, 365);
      expect(result).toBe(Number(
        (() => {
          const n = BigInt(999999999) * BigInt(9999) * BigInt(365);
          const d = BigInt(300000);
          const f = n / d;
          return n % d > 0n ? f + 1n : f;
        })()
      ));
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  describe("getUserPolicies pagination (Issue #72)", () => {
    const wallet = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ";

    const makeDbPolicy = (id: string) => ({
      id,
      productId: "prod-1",
      policyholder: wallet,
      coverageXlm: 500,
      premiumPaid: 25,
      oracleKey: "rainfall:0,0:2026-06",
      startTime: new Date("2026-01-01"),
      endTime: new Date("2026-04-01"),
      status: "ACTIVE",
      txHash: `tx-${id}`,
      createdAt: new Date("2026-01-01"),
    });

    it("returns paginated data with total, page, and limit", async () => {
      const dbPolicies = [makeDbPolicy("p1"), makeDbPolicy("p2")];
      mockPrismaService.policy.findMany.mockResolvedValue(dbPolicies);
      mockPrismaService.policy.count.mockResolvedValue(10);

      const result = await service.getUserPolicies(wallet, 1, 2);

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(10);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
    });

    it("calls prisma with correct take and skip for page 2", async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([]);
      mockPrismaService.policy.count.mockResolvedValue(0);

      await service.getUserPolicies(wallet, 2, 5);

      expect(mockPrismaService.policy.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5, skip: 5 }),
      );
    });

    it("clamps limit to 100 maximum", async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([]);
      mockPrismaService.policy.count.mockResolvedValue(0);

      const result = await service.getUserPolicies(wallet, 1, 999);

      expect(result.limit).toBe(100);
      expect(mockPrismaService.policy.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it("defaults to page=1 and limit=20 when not provided", async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([]);
      mockPrismaService.policy.count.mockResolvedValue(0);

      const result = await service.getUserPolicies(wallet);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(mockPrismaService.policy.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20, skip: 0 }),
      );
    });

    it("maps database rows to PolicySummary shape", async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([makeDbPolicy("p1")]);
      mockPrismaService.policy.count.mockResolvedValue(1);

      const result = await service.getUserPolicies(wallet, 1, 20);
      const p = result.data[0];

      expect(p.id).toBe("p1");
      expect(p.coverage).toBe("500");
      expect(p.premiumPaid).toBe("25");
      expect(typeof p.startTime).toBe("number");
      expect(typeof p.endTime).toBe("number");
    });
  });

  describe("confirmAndCreatePolicy XDR validation", () => {
    const validWallet = Keypair.random().publicKey();
    const validContract = StrKey.encodeContract(Buffer.alloc(32));

    function buildTestTxXdr(opts: {
      source?: string;
      contract?: string;
      function?: string;
      opType?: string;
      timeBounds?: { minTime: string; maxTime: string } | null;
    }) {
      const source = opts.source ?? validWallet;
      const account = new Account(source, "1");

      let op: any;
      if (opts.opType === "payment") {
        op = Operation.payment({
          destination: validWallet,
          asset: Asset.native(),
          amount: "10",
        });
      } else {
        op = Operation.invokeContractFunction({
          contract: opts.contract ?? validContract,
          function: opts.function ?? "buy_policy",
          args: [
            nativeToScVal("prod-1", { type: "string" }),
            nativeToScVal("500", { type: "string" }),
            nativeToScVal("rainfall:-0.0917,34.7679:2026-06", { type: "string" })
          ],
        });
      }

      const builder = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: "Test SDF Network ; September 2015",
      }).addOperation(op);

      // opts.timeBounds === null → no timeBounds at all (omit setTimeout)
      // opts.timeBounds provided → use it (custom timeBounds)
      // opts.timeBounds undefined → default future timeBounds
      if (opts.timeBounds === null) {
        (builder as any).timebounds = undefined;
        builder.setTimeout(0);
      } else if (opts.timeBounds) {
        builder.setTimebounds(
          parseInt(opts.timeBounds.minTime, 10),
          parseInt(opts.timeBounds.maxTime, 10),
        );
      } else {
        // Default: valid timeBounds 5 minutes in the future
        const nowSeconds = Math.floor(Date.now() / 1000);
        builder.setTimeout(300);
        void nowSeconds;
      }

      return builder.build().toXDR();
    }

    it("should pass validation and call simulateAssembleAndSend when transaction is valid", async () => {
      const validXdr = buildTestTxXdr({});
      const dto = {
        signedXdr: validXdr,
        productId: "prod-1",
        coverageXlm: 500,
        walletAddress: validWallet,
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      mockStellarService.simulateInvoke = jest.fn();
      mockStellarService.simulateAssembleAndSend = jest.fn().mockResolvedValue({
        status: "SUCCESS",
        hash: "tx-hash-123",
      });
      (service as any).stellar.networkPassphrase =
        "Test SDF Network ; September 2015";

      mockPrismaService.product.findMany.mockResolvedValue([
        {
          id: "prod-1",
          name: "Crop Product",
          category: "crop",
          triggerType: "Threshold",
          threshold: "50.0",
          comparison: "LessThan",
          coverageMin: "10.0",
          coverageMax: "1000.0",
          premiumRate: 500,
          maxDuration: 365,
          status: "Active",
        },
      ]);
      mockPrismaService.policy.create.mockResolvedValue({ id: "policy-123" });

      const result = await service.confirmAndCreatePolicy(dto, validWallet);
      expect(result.policyId).toBe("policy-123");
      expect(result.txHash).toBe("tx-hash-123");
    });

    it("throws GoneException (410) when XDR timeBounds.maxTime has already passed", async () => {
      const pastTime = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const expiredXdr = buildTestTxXdr({
        timeBounds: { minTime: "0", maxTime: String(pastTime) },
      });

      const dto = {
        signedXdr: expiredXdr,
        productId: "prod-1",
        coverageXlm: 500,
        walletAddress: validWallet,
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      await expect(
        service.confirmAndCreatePolicy(dto, validWallet),
      ).rejects.toThrow(GoneException);

      await expect(
        service.confirmAndCreatePolicy(dto, validWallet),
      ).rejects.toThrow(/Signed XDR has expired/);
    });

    it("throws GoneException (410) when XDR has no timeBounds", async () => {
      const account = new Account(validWallet, "1");
      const op = Operation.invokeContractFunction({
        contract: validContract,
        function: "buy_policy",
        args: [],
      });
      // Build with setTimeout(0) which sets maxTime to 0 (no bounds)
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: "Test SDF Network ; September 2015",
      })
        .addOperation(op)
        .setTimeout(0)
        .build();
      const noTimeBoundsXdr = tx.toXDR();

      const dto = {
        signedXdr: noTimeBoundsXdr,
        productId: "prod-1",
        coverageXlm: 500,
        walletAddress: validWallet,
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      await expect(
        service.confirmAndCreatePolicy(dto, validWallet),
      ).rejects.toThrow(GoneException);
    });

    it("should throw BadRequestException if source account does not match wallet address", async () => {
      const otherKey = Keypair.random().publicKey();
      const mismatchedXdr = buildTestTxXdr({ source: otherKey });

      const dto = {
        signedXdr: mismatchedXdr,
        productId: "prod-1",
        coverageXlm: 500,
        walletAddress: validWallet,
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      await expect(
        service.confirmAndCreatePolicy(dto, validWallet),
      ).rejects.toThrow(
        /Transaction source account.*does not match the authenticated wallet/,
      );
    });

    it("should throw BadRequestException if first operation is not invokeHostFunction", async () => {
      const invalidOpXdr = buildTestTxXdr({ opType: "payment" });
      const dto = {
        signedXdr: invalidOpXdr,
        productId: "prod-1",
        coverageXlm: 500,
        walletAddress: validWallet,
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      await expect(
        service.confirmAndCreatePolicy(dto, validWallet),
      ).rejects.toThrow(
        /Expected first operation type to be invokeHostFunction, got payment/,
      );
    });

    it("should throw BadRequestException if target contract does not match POLICY_ENGINE_CONTRACT", async () => {
      const otherContract = StrKey.encodeContract(
        Buffer.from(new Array(32).fill(1)),
      );
      const invalidContractXdr = buildTestTxXdr({ contract: otherContract });
      const dto = {
        signedXdr: invalidContractXdr,
        productId: "prod-1",
        coverageXlm: 500,
        walletAddress: validWallet,
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      await expect(
        service.confirmAndCreatePolicy(dto, validWallet),
      ).rejects.toThrow(
        /Transaction targets contract.*expected POLICY_ENGINE_CONTRACT/,
      );
    });

    it("should throw BadRequestException if contract function is not buy_policy", async () => {
      const invalidFunctionXdr = buildTestTxXdr({ function: "wrong_method" });
      const dto = {
        signedXdr: invalidFunctionXdr,
        productId: "prod-1",
        coverageXlm: 500,
        walletAddress: validWallet,
        duration: 90,
        oracleKey: "rainfall:-0.0917,34.7679:2026-06",
      };

      await expect(
        service.confirmAndCreatePolicy(dto, validWallet),
      ).rejects.toThrow(/Transaction calls function.*expected 'buy_policy'/);
    });
  });
});
