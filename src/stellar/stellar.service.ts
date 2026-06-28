import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Networks,
  Keypair,
  TransactionBuilder,
  Transaction,
  BASE_FEE,
  Operation,
  Contract,
  rpc as StellarRpc,
  Horizon,
  xdr,
} from "@stellar/stellar-sdk";

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
    const rpcUrl =
      config.get<string>("STELLAR_RPC_URL") ??
      "https://soroban-testnet.stellar.org";
    this.rpc = new StellarRpc.Server(rpcUrl);
    this.network =
      config.get<string>("STELLAR_NETWORK") === "mainnet"
        ? Networks.PUBLIC
        : Networks.TESTNET;
    const secret = config.get<string>("KEEPER_SECRET_KEY") ?? "";
    this.keeperKeypair = secret ? Keypair.fromSecret(secret) : Keypair.random();
  }

  /** Simulate a read-only contract invocation and return the result XDR. */
  async simulateInvoke(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<StellarRpc.Api.SimulateTransactionResponse> {
    const account = await this.rpc.getAccount(this.keeperKeypair.publicKey());
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.network,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    return this.rpc.simulateTransaction(tx);
  }

  /**
   * Invoke a Soroban contract method as a write operation.
   * Builds the transaction, simulates it, and submits it to the network.
   * Returns the transaction hash on success.
   */
  async invokeContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    signerKeypair?: Keypair,
  ): Promise<string> {
    const signer = signerKeypair ?? this.keeperKeypair;
    const contract = new Contract(contractId);
    const MAX_ATTEMPTS = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Re-fetch account on every attempt to get a fresh sequence number;
        // reusing a stale assembled transaction causes TRANSACTION_BAD_SEQ on retry.
        const account = await this.rpc.getAccount(signer.publicKey());
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.network,
        })
          .addOperation(contract.call(method, ...args))
          .setTimeout(30)
          .build();

        const simResult = await this.rpc.simulateTransaction(tx);
        if (StellarRpc.Api.isSimulationError(simResult)) {
          throw new Error(`Simulation failed: ${simResult.error}`);
        }

        const assembledTx = StellarRpc.assembleTransaction(
          tx,
          simResult,
        ).build();
        assembledTx.sign(signer);

        const sendResult = await this.rpc.sendTransaction(assembledTx);
        if (sendResult.status === "ERROR") {
          throw new Error(
            `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`,
          );
        }
        this.logger.log(
          `Contract invoked: ${contractId}.${method} → txHash=${sendResult.hash} (attempt ${attempt})`,
        );
        return sendResult.hash;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          `sendTransaction attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(2000);
        }
      }
    }

    throw new Error(
      `All ${MAX_ATTEMPTS} sendTransaction attempts failed. Last error: ${lastError?.message}`,
    );
  }

  /**
   * Simulate a raw transaction, assemble it with the simulation result,
   * sign it with the keeper key, and send it to the network.
   *
   * This is the correct flow for Soroban contract invocations:
   *   simulate → assembleTransaction → sign → sendTransaction
   *
   * Assembling appends resource fees and authorization footprints from
   * the simulation result — without this step the RPC will reject the
   * transaction with TRANSACTION_FAILED or INSUFFICIENT_FEE.
   */
  async simulateAssembleAndSend(
    tx: Transaction,
  ): Promise<StellarRpc.Api.SendTransactionResponse> {
    const simResult = await this.rpc.simulateTransaction(tx);
    if (StellarRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const assembledTx = StellarRpc.assembleTransaction(tx, simResult).build();
    assembledTx.sign(this.keeperKeypair);

    const sendResult = await this.rpc.sendTransaction(assembledTx);
    if (sendResult.status === "ERROR") {
      throw new Error(
        `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`,
      );
    }

    this.logger.log(
      `Transaction sent: txHash=${sendResult.hash} status=${sendResult.status}`,
    );
    return sendResult;
  }

  /**
   * Poll getTransaction until the status is SUCCESS or FAILED.
   * Throws on FAILED or if the timeout is reached.
   *
   * @param txHash  Transaction hash to poll
   * @param timeoutMs  Maximum time to wait in milliseconds (default 60s)
   * @returns The final transaction response with status SUCCESS
   */
  async waitForTransaction(
    txHash: string,
    timeoutMs: number = 60000,
  ): Promise<StellarRpc.Api.GetTransactionResponse> {
    const start = Date.now();
    const POLL_INTERVAL_MS = 2000;

    while (Date.now() - start < timeoutMs) {
      const txResult = await this.rpc.getTransaction(txHash);

      if (txResult.status === "SUCCESS") {
        this.logger.log(`Transaction confirmed: ${txHash}`);
        return txResult;
      }

      if (txResult.status === "FAILED") {
        throw new Error(
          `Transaction ${txHash} failed on-chain: ${txResult.resultXdr ?? "unknown error"}`,
        );
      }

      this.logger.log(
        `Transaction ${txHash} status=${txResult.status} — waiting ${POLL_INTERVAL_MS}ms...`,
      );
      await this.sleep(POLL_INTERVAL_MS);
    }

    throw new Error(
      `Transaction ${txHash} did not reach SUCCESS within ${timeoutMs}ms`,
    );
  }

  /** Sleep for the given number of milliseconds. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get the native XLM balance for an account.
   * Used for keeper health checks to ensure the keeper has sufficient funds.
   */
  async getAccountBalance(publicKey: string): Promise<string> {
    const account = (await this.rpc.getAccount(
      publicKey,
    )) as Horizon.AccountResponse;
    const nativeBalance = account.balances.find(
      (b): b is Horizon.HorizonApi.BalanceLineNative =>
        b.asset_type === "native",
    );
    if (!nativeBalance) {
      this.logger.warn(`No native XLM balance found for account: ${publicKey}`);
      return "0";
    }
    this.logger.log(
      `Account ${publicKey} balance: ${nativeBalance.balance} XLM`,
    );
    return nativeBalance.balance;
  }

  /** Return the current network passphrase. */
  get networkPassphrase(): string {
    return this.network;
  }

  get rpcServer(): StellarRpc.Server {
    return this.rpc;
  }
}
