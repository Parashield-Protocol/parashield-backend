import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StellarService } from './stellar.service';

jest.mock('@stellar/stellar-sdk', () => ({
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC:  'Public Global Stellar Network ; September 2015',
  },
  Keypair: {
    fromSecret: jest.fn().mockReturnValue({ publicKey: () => 'GSIGNER', sign: jest.fn() }),
    random:     jest.fn().mockReturnValue({ publicKey: () => 'GRANDOM', sign: jest.fn() }),
  },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout:   jest.fn().mockReturnThis(),
    build:        jest.fn().mockReturnValue({}),
  })),
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn().mockReturnValue({}),
  })),
  BASE_FEE: '100',
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

describe('StellarService.invokeContract — retry rebuild', () => {
  let service: StellarService;
  let mockRpc: {
    getAccount:          jest.Mock;
    simulateTransaction: jest.Mock;
    sendTransaction:     jest.Mock;
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'STELLAR_RPC_URL')      return 'https://soroban-testnet.stellar.org';
      if (key === 'STELLAR_NETWORK')      return 'testnet';
      if (key === 'KEEPER_SECRET_KEY')    return 'STEST_FAKE_SECRET_KEY';
      return undefined;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockRpc = {
      getAccount:          jest.fn().mockResolvedValue({ id: 'GSIGNER', sequence: '100' }),
      simulateTransaction: jest.fn().mockResolvedValue({ result: {} }),
      sendTransaction:     jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'tx-hash' }),
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
    jest.spyOn(service as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
  });

  it('re-fetches account (rebuilds) on each retry after a network timeout', async () => {
    const networkError = new Error('ECONNRESET: connection reset by peer');
    mockRpc.sendTransaction
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'tx-hash-retry' });

    const hash = await service.invokeContract('CONTRACT_ID', 'my_method', []);

    expect(hash).toBe('tx-hash-retry');
    // getAccount must be called once per attempt — 2 calls total (attempt 1 failed, attempt 2 succeeded)
    expect(mockRpc.getAccount).toHaveBeenCalledTimes(2);
  });

  it('succeeds on the first attempt without any retry', async () => {
    mockRpc.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'first-try-hash' });

    const hash = await service.invokeContract('CONTRACT_ID', 'my_method', []);

    expect(hash).toBe('first-try-hash');
    expect(mockRpc.getAccount).toHaveBeenCalledTimes(1);
  });

  it('throws after all 3 attempts are exhausted and calls getAccount 3 times', async () => {
    mockRpc.sendTransaction.mockRejectedValue(new Error('Network timeout'));

    await expect(
      service.invokeContract('CONTRACT_ID', 'my_method', []),
    ).rejects.toThrow('All 3 sendTransaction attempts failed');

    expect(mockRpc.getAccount).toHaveBeenCalledTimes(3);
  });
});
