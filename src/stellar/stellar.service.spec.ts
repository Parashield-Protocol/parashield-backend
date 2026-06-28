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
  });
});
