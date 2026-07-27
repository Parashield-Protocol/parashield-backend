import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { StellarService } from "./stellar.service";

jest.mock("@stellar/stellar-sdk", () => ({
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
  Keypair: {
    fromSecret: jest
      .fn()
      .mockReturnValue({ publicKey: () => "GSIGNER", sign: jest.fn() }),
    random: jest
      .fn()
      .mockReturnValue({ publicKey: () => "GRANDOM", sign: jest.fn() }),
  },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
  Contract: jest.fn().mockImplementation((contractId: string) => ({
    contractId,
    call: jest.fn().mockReturnValue({ contractCall: true }),
  })),
  BASE_FEE: "100",
  xdr: {},
  rpc: {
    Server: jest.fn().mockImplementation(() => ({})),
    Api: {
      isSimulationError: jest.fn().mockReturnValue(false),
    },
    assembleTransaction: jest.fn().mockReturnValue({
      build: jest.fn().mockReturnValue({ sign: jest.fn() }),
    }),
  },
  // #185 — getAccountBalance uses a separate Horizon client (balances only
  // exist on a Horizon account response, not on rpc.Server.getAccount()'s).
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({})),
  },
}));

describe("StellarService", () => {
  describe("simulateInvoke — Contract class fix", () => {
    let service: StellarService;
    let mockRpc: {
      getAccount: jest.Mock;
      simulateTransaction: jest.Mock;
    };
    let MockContract: jest.Mock;

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === "STELLAR_RPC_URL")
          return "https://soroban-testnet.stellar.org";
        if (key === "STELLAR_NETWORK") return "testnet";
        if (key === "KEEPER_SECRET_KEY") return "STEST_FAKE_SECRET_KEY";
        return undefined;
      }),
    };

    beforeEach(async () => {
      jest.clearAllMocks();

      mockRpc = {
        getAccount: jest
          .fn()
          .mockResolvedValue({ id: "GSIGNER", sequence: "100" }),
        simulateTransaction: jest
          .fn()
          .mockResolvedValue({ result: { returnValue: "success" } }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StellarService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      service = module.get<StellarService>(StellarService);

      // Replace the internal rpc instance with the mock so we can control behavior
      (service as unknown as { rpc: typeof mockRpc }).rpc = mockRpc;

      // Get the mocked Contract constructor
      const StellarSDK = require("@stellar/stellar-sdk");
      MockContract = StellarSDK.Contract;
    });

    it("should accept a StrKey contract ID (e.g., CALFQS...)", async () => {
      const testnetContractId =
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
      const args: any[] = [];

      await service.simulateInvoke(testnetContractId, "read_data", args);

      // Verify Contract was instantiated with the StrKey contract ID
      expect(MockContract).toHaveBeenCalledWith(testnetContractId);
    });

    it("should call contract.call() with the method name and args", async () => {
      const testnetContractId =
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
      const methodName = "get_balance";
      const args: any[] = [{ type: "sym", sym: "test" }];

      await service.simulateInvoke(testnetContractId, methodName, args);

      // Verify the mocked Contract instance was created and call() was invoked
      expect(MockContract).toHaveBeenCalledWith(testnetContractId);
      const contractInstance = MockContract.mock.results[0].value;
      expect(contractInstance.call).toHaveBeenCalledWith(methodName, ...args);
    });

    it("should build a transaction with the contract call operation", async () => {
      const testnetContractId =
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
      const StellarSDK = require("@stellar/stellar-sdk");
      const MockTransactionBuilder = StellarSDK.TransactionBuilder;

      await service.simulateInvoke(testnetContractId, "read_data", []);

      // Verify TransactionBuilder was called and methods were chained
      expect(MockTransactionBuilder).toHaveBeenCalled();
      const builderInstance = MockTransactionBuilder.mock.results[0].value;
      expect(builderInstance.addOperation).toHaveBeenCalled();
      expect(builderInstance.setTimeout).toHaveBeenCalledWith(30);
      expect(builderInstance.build).toHaveBeenCalled();
    });

    it("should simulate the transaction on the RPC", async () => {
      const testnetContractId =
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

      const result = await service.simulateInvoke(
        testnetContractId,
        "read_data",
        [],
      );

      expect(mockRpc.simulateTransaction).toHaveBeenCalled();
      expect(result).toEqual({ result: { returnValue: "success" } });
    });

    it("should use the keeper keypair for the account lookup", async () => {
      const testnetContractId =
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

      await service.simulateInvoke(testnetContractId, "read_data", []);

      // The keeper's public key should be used in getAccount
      expect(mockRpc.getAccount).toHaveBeenCalledWith("GSIGNER");
    });

    it("should handle empty args array", async () => {
      const testnetContractId =
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

      await service.simulateInvoke(testnetContractId, "no_args", []);

      const contractInstance = MockContract.mock.results[0].value;
      expect(contractInstance.call).toHaveBeenCalledWith("no_args");
    });

    it("should handle multiple args", async () => {
      const testnetContractId =
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
      const args: any[] = [
        { type: "u128", u128: "1000" },
        { type: "sym", sym: "test" },
        { type: "bool", bool: true },
      ];

      await service.simulateInvoke(
        testnetContractId,
        "complex_call",
        args as any,
      );

      const contractInstance = MockContract.mock.results[0].value;
      expect(contractInstance.call).toHaveBeenCalledWith(
        "complex_call",
        ...args,
      );
    });

    it("should throw if getAccount fails", async () => {
      const testnetContractId =
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
      mockRpc.getAccount.mockRejectedValueOnce(
        new Error("RPC connection failed"),
      );

      await expect(
        service.simulateInvoke(testnetContractId, "read_data", []),
      ).rejects.toThrow("RPC connection failed");
    });

    it("should throw if simulateTransaction fails", async () => {
      const testnetContractId =
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
      mockRpc.simulateTransaction.mockRejectedValueOnce(
        new Error("Simulation failed"),
      );

      await expect(
        service.simulateInvoke(testnetContractId, "read_data", []),
      ).rejects.toThrow("Simulation failed");
    });

    it("should NOT try to decode hex or use xdr.Hash", async () => {
      const testnetContractId =
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
      const StellarSDK = require("@stellar/stellar-sdk");

      await service.simulateInvoke(testnetContractId, "read_data", []);

      // Verify Contract was called (not xdr.Hash or hex decoding)
      expect(MockContract).toHaveBeenCalledWith(testnetContractId);

      // Verify xdr.Hash was NOT used
      if (StellarSDK.xdr?.Hash) {
        expect(StellarSDK.xdr.Hash.fromXDR).not.toHaveBeenCalled();
      }
    });
  });

  describe("StellarService.invokeContract — retry rebuild", () => {
    let service: StellarService;
    let mockRpc: {
      getAccount: jest.Mock;
      simulateTransaction: jest.Mock;
      sendTransaction: jest.Mock;
      getTransaction: jest.Mock;
    };

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === "STELLAR_RPC_URL")
          return "https://soroban-testnet.stellar.org";
        if (key === "STELLAR_NETWORK") return "testnet";
        if (key === "KEEPER_SECRET_KEY") return "STEST_FAKE_SECRET_KEY";
        return undefined;
      }),
    };

    beforeEach(async () => {
      jest.clearAllMocks();

      mockRpc = {
        getAccount: jest
          .fn()
          .mockResolvedValue({ id: "GSIGNER", sequence: "100" }),
        simulateTransaction: jest.fn().mockResolvedValue({ result: {} }),
        sendTransaction: jest
          .fn()
          .mockResolvedValue({ status: "PENDING", hash: "tx-hash" }),
        getTransaction: jest
          .fn()
          .mockResolvedValue({ status: "SUCCESS" }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StellarService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      service = module.get<StellarService>(StellarService);

      // Replace the internal rpc instance with the mock so we can control behavior
      (service as unknown as { rpc: typeof mockRpc }).rpc = mockRpc;

      // Make sleep a no-op to keep tests fast
      jest
        .spyOn(
          service as unknown as { sleep: (ms: number) => Promise<void> },
          "sleep",
        )
        .mockResolvedValue(undefined);
    });

    it("re-fetches account (rebuilds) on each retry after a network timeout", async () => {
      const networkError = new Error("ECONNRESET: connection reset by peer");
      mockRpc.sendTransaction
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ status: "PENDING", hash: "tx-hash-retry" });

      const hash = await service.invokeContract("CONTRACT_ID", "my_method", []);

      expect(hash).toBe("tx-hash-retry");
      // getAccount must be called once per attempt — 2 calls total (attempt 1 failed, attempt 2 succeeded)
      expect(mockRpc.getAccount).toHaveBeenCalledTimes(2);
    });

    it("succeeds on the first attempt without any retry", async () => {
      mockRpc.sendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "first-try-hash",
      });

      const hash = await service.invokeContract("CONTRACT_ID", "my_method", []);

      expect(hash).toBe("first-try-hash");
      expect(mockRpc.getAccount).toHaveBeenCalledTimes(1);
    });

    it("throws after all 3 attempts are exhausted and calls getAccount 3 times", async () => {
      mockRpc.sendTransaction.mockRejectedValue(new Error("Network timeout"));

      await expect(
        service.invokeContract("CONTRACT_ID", "my_method", []),
      ).rejects.toThrow("All 3 sendTransaction attempts failed");

      expect(mockRpc.getAccount).toHaveBeenCalledTimes(3);
    });

    it("returns existing hash without re-sending if previous send already landed (dedup check)", async () => {
      // Scenario: sendTransaction returns ERROR status (captured as lastSentHash), causing a throw,
      // then on retry the dedup check finds it already landed via getTransaction.
      mockRpc.sendTransaction
        .mockResolvedValueOnce({ status: "ERROR", hash: "tx-hash-landed", errorResult: "timeout" })
        .mockResolvedValueOnce({ status: "PENDING", hash: "tx-hash-retry" });

      // On retry (attempt 2), getTransaction reveals the first tx already landed
      mockRpc.getTransaction.mockResolvedValueOnce({ status: "SUCCESS" });

      const hash = await service.invokeContract("CONTRACT_ID", "my_method", []);

      // sendTransaction was only called once — dedup short-circuited the retry
      expect(mockRpc.sendTransaction).toHaveBeenCalledTimes(1);
      // getTransaction was called once on attempt 2 to confirm prior tx status
      expect(mockRpc.getTransaction).toHaveBeenCalledTimes(1);
      // Returns the hash from the already-landed first send
      expect(hash).toBe("tx-hash-landed");
    });

    it("calls waitForTransaction after send to confirm finality before returning hash", async () => {
      mockRpc.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "pending-hash" });
      mockRpc.getTransaction
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValueOnce({ status: "SUCCESS" });

      const hash = await service.invokeContract("CONTRACT_ID", "my_method", []);

      expect(hash).toBe("pending-hash");
      // getTransaction is called once for NOT_FOUND, once for SUCCESS (finality poll)
      expect(mockRpc.getTransaction).toHaveBeenCalledWith("pending-hash");
      expect(mockRpc.getTransaction).toHaveBeenCalledTimes(2);
    });

    it("throws if the on-chain transaction FAILED after submission", async () => {
      mockRpc.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "fail-hash" });
      mockRpc.getTransaction.mockResolvedValue({ status: "FAILED", resultXdr: "on-chain-error" });

      await expect(
        service.invokeContract("CONTRACT_ID", "my_method", []),
      ).rejects.toThrow("fail-hash");
    });

    it("does not call getTransaction for dedup on first attempt (only for finality confirmation)", async () => {
      mockRpc.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "first-hash" });

      await service.invokeContract("CONTRACT_ID", "my_method", []);

      // getTransaction is called once — by waitForTransaction for finality, not dedup
      expect(mockRpc.getTransaction).toHaveBeenCalledTimes(1);
    });

    // #189 — invokeContract's own #187 fail-fast behavior for deterministic
    // simulation failures: no retry, no backoff sleep, immediate throw.
    it("#187 — fails fast on a simulation error without retrying", async () => {
      const StellarSDK = require("@stellar/stellar-sdk");
      StellarSDK.rpc.Api.isSimulationError.mockReturnValue(true);
      mockRpc.simulateTransaction.mockResolvedValue({ error: "contract reverted: InsufficientFunds" });

      await expect(
        service.invokeContract("CONTRACT_ID", "my_method", []),
      ).rejects.toThrow("Simulation failed");

      // Only one attempt — getAccount is called once per attempt, so a
      // single call proves no retry happened.
      expect(mockRpc.getAccount).toHaveBeenCalledTimes(1);
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();

      StellarSDK.rpc.Api.isSimulationError.mockReturnValue(false);
    });

    // #189 — DUPLICATE means the network already saw this exact envelope,
    // so it's correct to fall through to waitForTransaction like a normal
    // PENDING status (the tx is genuinely in-flight or landed).
    it("#189 — proceeds to waitForTransaction on a DUPLICATE send status", async () => {
      mockRpc.sendTransaction.mockResolvedValue({ status: "DUPLICATE", hash: "dup-hash" });
      mockRpc.getTransaction.mockResolvedValue({ status: "SUCCESS" });

      const hash = await service.invokeContract("CONTRACT_ID", "my_method", []);

      expect(hash).toBe("dup-hash");
      expect(mockRpc.getTransaction).toHaveBeenCalledWith("dup-hash");
    });

    // #183 — TRY_AGAIN_LATER means the RPC node's queue rejected the
    // submission outright: it was never broadcast, so waitForTransaction
    // must never be called for it (that hash will never land). The attempt
    // loop should fail this attempt immediately and retry.
    it("#183 — fails fast on TRY_AGAIN_LATER and retries rather than waiting for a hash that was never broadcast", async () => {
      mockRpc.sendTransaction
        .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER", hash: "retry-later-hash" })
        .mockResolvedValueOnce({ status: "PENDING", hash: "tx-hash-second-attempt" });
      // The never-broadcast hash can never be found (dedup check on attempt
      // 2 must not mistake "rejected outright" for "already landed"); the
      // second attempt's real hash then confirms normally.
      mockRpc.getTransaction
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValue({ status: "SUCCESS" });

      const hash = await service.invokeContract("CONTRACT_ID", "my_method", []);

      expect(hash).toBe("tx-hash-second-attempt");
      expect(mockRpc.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it("#183 — throws after exhausting all attempts if every send is rejected with TRY_AGAIN_LATER", async () => {
      mockRpc.sendTransaction.mockResolvedValue({ status: "TRY_AGAIN_LATER", hash: "retry-later-hash" });
      // Dedup checks on attempts 2/3 legitimately query the never-broadcast
      // hash as a safety net; it must never be found, since it never landed.
      mockRpc.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

      await expect(service.invokeContract("CONTRACT_ID", "my_method", [])).rejects.toThrow(
        /TRY_AGAIN_LATER/,
      );
    });
  });

  describe("simulateAssembleAndSend", () => {
    let service: StellarService;
    let mockRpc: {
      simulateTransaction: jest.Mock;
      sendTransaction: jest.Mock;
    };

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === "STELLAR_RPC_URL") return "https://soroban-testnet.stellar.org";
        if (key === "STELLAR_NETWORK") return "testnet";
        if (key === "KEEPER_SECRET_KEY") return "STEST_FAKE_SECRET_KEY";
        return undefined;
      }),
    };

    beforeEach(async () => {
      jest.clearAllMocks();

      mockRpc = {
        simulateTransaction: jest.fn().mockResolvedValue({ result: {} }),
        sendTransaction: jest.fn().mockResolvedValue({ status: "PENDING", hash: "assembled-hash" }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StellarService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      service = module.get<StellarService>(StellarService);
      (service as unknown as { rpc: typeof mockRpc }).rpc = mockRpc;
    });

    it("simulates, assembles, signs, and sends the transaction", async () => {
      const fakeTx = { sign: jest.fn() } as any;

      const result = await service.simulateAssembleAndSend(fakeTx);

      expect(mockRpc.simulateTransaction).toHaveBeenCalledWith(fakeTx);
      expect(mockRpc.sendTransaction).toHaveBeenCalled();
      expect(result).toEqual({ status: "PENDING", hash: "assembled-hash" });
    });

    it("#187 — throws a SimulationFailedError (not a generic Error) when simulation fails", async () => {
      const StellarSDK = require("@stellar/stellar-sdk");
      StellarSDK.rpc.Api.isSimulationError.mockReturnValue(true);
      mockRpc.simulateTransaction.mockResolvedValue({ error: "contract reverted" });

      const { SimulationFailedError } = require("./stellar.service");
      const fakeTx = { sign: jest.fn() } as any;

      await expect(service.simulateAssembleAndSend(fakeTx)).rejects.toThrow(SimulationFailedError);
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();

      StellarSDK.rpc.Api.isSimulationError.mockReturnValue(false);
    });

    it("throws when sendTransaction returns an ERROR status", async () => {
      mockRpc.sendTransaction.mockResolvedValue({
        status: "ERROR",
        errorResult: "insufficient fee",
      });
      const fakeTx = { sign: jest.fn() } as any;

      await expect(service.simulateAssembleAndSend(fakeTx)).rejects.toThrow(
        "Transaction submission failed",
      );
    });

    // #183 — this method has no waitForTransaction step of its own, so a
    // TRY_AGAIN_LATER (never broadcast) result must never be handed back to
    // the caller shaped like a normal in-flight send.
    it("#183 — throws when sendTransaction returns a TRY_AGAIN_LATER status", async () => {
      mockRpc.sendTransaction.mockResolvedValue({
        status: "TRY_AGAIN_LATER",
        hash: "retry-later-hash",
      });
      const fakeTx = { sign: jest.fn() } as any;

      await expect(service.simulateAssembleAndSend(fakeTx)).rejects.toThrow(
        /TRY_AGAIN_LATER/,
      );
    });
  });

  describe("waitForTransaction", () => {
    let service: StellarService;
    let mockRpc: { getTransaction: jest.Mock };

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === "STELLAR_RPC_URL") return "https://soroban-testnet.stellar.org";
        if (key === "STELLAR_NETWORK") return "testnet";
        if (key === "KEEPER_SECRET_KEY") return "STEST_FAKE_SECRET_KEY";
        return undefined;
      }),
    };

    beforeEach(async () => {
      jest.clearAllMocks();

      mockRpc = { getTransaction: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StellarService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      service = module.get<StellarService>(StellarService);
      (service as unknown as { rpc: typeof mockRpc }).rpc = mockRpc;
      jest
        .spyOn(service as unknown as { sleep: (ms: number) => Promise<void> }, "sleep")
        .mockResolvedValue(undefined);
    });

    it("resolves once the transaction reaches SUCCESS", async () => {
      mockRpc.getTransaction
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValueOnce({ status: "SUCCESS" });

      const result = await service.waitForTransaction("tx-hash", 10_000);

      expect(result.status).toBe("SUCCESS");
    });

    it("throws when the transaction reaches FAILED", async () => {
      mockRpc.getTransaction.mockResolvedValue({ status: "FAILED", resultXdr: "revert-reason" });

      await expect(service.waitForTransaction("tx-hash", 10_000)).rejects.toThrow(
        "failed on-chain",
      );
    });

    // #189 — the timeout path itself (never reaching SUCCESS or FAILED)
    // was never exercised; only invokeContract's wrapping of a FAILED
    // result was tested.
    it("#189 — throws once timeoutMs elapses without reaching SUCCESS or FAILED", async () => {
      mockRpc.getTransaction.mockResolvedValue({ status: "PENDING" });

      await expect(service.waitForTransaction("tx-hash", 50)).rejects.toThrow(
        "did not reach SUCCESS within 50ms",
      );
    });

    it("#248 — retries on transient RPC network errors until SUCCESS is reached", async () => {
      mockRpc.getTransaction
        .mockRejectedValueOnce(new Error("RPC gateway timeout"))
        .mockResolvedValueOnce({ status: "SUCCESS" });

      const result = await service.waitForTransaction("tx-hash", 10_000);

      expect(result.status).toBe("SUCCESS");
      expect(mockRpc.getTransaction).toHaveBeenCalledTimes(2);
    });
  });

  describe("formatXdr", () => {
    let service: StellarService;

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === "STELLAR_RPC_URL") return "https://soroban-testnet.stellar.org";
        if (key === "STELLAR_NETWORK") return "testnet";
        if (key === "KEEPER_SECRET_KEY") return "STEST_FAKE_SECRET_KEY";
        return undefined;
      }),
    };

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StellarService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      service = module.get<StellarService>(StellarService);
    });

    it("#247 — formats XDR SDK class instances with toXDR method to base64 string", () => {
      const mockXdrInstance = {
        toXDR: jest.fn().mockReturnValue("AAAAAQAAAAE="),
      };
      expect(service.formatXdr(mockXdrInstance)).toBe("AAAAAQAAAAE=");
      expect(mockXdrInstance.toXDR).toHaveBeenCalledWith("base64");
    });

    it("#247 — returns plain strings directly", () => {
      expect(service.formatXdr("tx_failed_bad_seq")).toBe("tx_failed_bad_seq");
    });

    it("#247 — handles empty or null/undefined values safely", () => {
      expect(service.formatXdr(null)).toBe("");
      expect(service.formatXdr(undefined)).toBe("");
    });
  });

  describe("getAccountBalance", () => {
    let service: StellarService;
    let mockHorizon: { loadAccount: jest.Mock };

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === "STELLAR_RPC_URL") return "https://soroban-testnet.stellar.org";
        if (key === "STELLAR_NETWORK") return "testnet";
        if (key === "KEEPER_SECRET_KEY") return "STEST_FAKE_SECRET_KEY";
        return undefined;
      }),
    };

    beforeEach(async () => {
      jest.clearAllMocks();

      mockHorizon = { loadAccount: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StellarService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      service = module.get<StellarService>(StellarService);
      // #185 — balances come from a Horizon account response, not from
      // `rpc.Server.getAccount()` (which has no `.balances` field at all).
      // Mocking `rpc.getAccount` here would pass against a shape the real
      // RPC client never returns, masking exactly the bug this regression
      // test exists to catch.
      (service as unknown as { horizon: typeof mockHorizon }).horizon = mockHorizon;
    });

    it("#189/#185 — returns the native XLM balance for the account", async () => {
      mockHorizon.loadAccount.mockResolvedValue({
        balances: [
          { asset_type: "native", balance: "123.4567890" },
          { asset_type: "credit_alphanum4", balance: "5.0000000", asset_code: "USDC" },
        ],
      });

      const balance = await service.getAccountBalance("GSOMEACCOUNT");

      expect(balance).toBe("123.4567890");
      expect(mockHorizon.loadAccount).toHaveBeenCalledWith("GSOMEACCOUNT");
    });

    it("#189/#185 — returns '0' when the account has no native XLM balance line", async () => {
      mockHorizon.loadAccount.mockResolvedValue({
        balances: [{ asset_type: "credit_alphanum4", balance: "5.0000000", asset_code: "USDC" }],
      });

      const balance = await service.getAccountBalance("GSOMEACCOUNT");

      expect(balance).toBe("0");
    });

    it("#189/#185 — propagates the error when the Horizon account lookup fails", async () => {
      mockHorizon.loadAccount.mockRejectedValue(new Error("account not found"));

      await expect(service.getAccountBalance("GSOMEACCOUNT")).rejects.toThrow("account not found");
    });
  });
});
