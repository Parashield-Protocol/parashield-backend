import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Networks,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  rpc as StellarRpc,
  xdr,
} from '@stellar/stellar-sdk';

/**
 * StellarService — thin wrapper over the Stellar SDK for Soroban contract calls.
 *
 * Responsibilities:
 *  - Build and submit Soroban transactions to the RPC
 *  - Read contract data (simulate calls)
 *  - Manage the keeper keypair for automated submissions
 */
@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private readonly rpc: StellarRpc.Server;
  private readonly network: string;
  readonly keeperKeypair: Keypair;

  constructor(private readonly config: ConfigService) {
    const rpcUrl = config.get<string>('STELLAR_RPC_URL') ??
      'https://soroban-testnet.stellar.org';
    this.rpc     = new StellarRpc.Server(rpcUrl);
    this.network = config.get<string>('STELLAR_NETWORK') === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
    const secret = config.get<string>('KEEPER_SECRET_KEY') ?? '';
    this.keeperKeypair = secret ? Keypair.fromSecret(secret) : Keypair.random();
  }

  /** Simulate a read-only contract invocation and return the result XDR. */
  async simulateInvoke(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<StellarRpc.Api.SimulateTransactionResponse> {
    const account = await this.rpc.getAccount(this.keeperKeypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.network,
    })
      .addOperation(
        // @ts-expect-error — Stellar SDK invokeContractFunction helper
        xdr.Operation.invokeContractFunction({
          contractAddress: xdr.ScAddress.scAddressTypeContract(
            xdr.Hash.fromXDR(Buffer.from(contractId, 'hex')),
          ),
          functionName: method,
          args,
        }),
      )
      .setTimeout(30)
      .build();

    return this.rpc.simulateTransaction(tx);
  }

  /** Return the current network passphrase. */
  get networkPassphrase(): string {
    return this.network;
  }

  get rpcServer(): StellarRpc.Server {
    return this.rpc;
  }
}
