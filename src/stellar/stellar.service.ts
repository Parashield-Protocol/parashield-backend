import { Injectable, Logger, HttpException, HttpStatus } from "@nestjs/common";
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
 * #187 — a reverting contract call is a deterministic simulation failure:
 * the same inputs against the same on-chain state will fail identically
 * every time, so retrying it like a transient network error just wastes
 * time and buries the real revert reason behind a generic "all attempts
 * failed" message. Thrown instead of a plain Error so callers with retry
 * loops can distinguish "don't bother retrying this" from "try again."
 */
export class SimulationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationFailedError";
  }
}

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
  private readonly horizon: Horizon.Server;
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
    // #185 — balances only exist on a Horizon account response, not on the
    // lightweight object `rpc.Server.getAccount()` returns (that's meant for
    // building transactions: sequence number only, no `.balances`). A
    // separate Horizon client is required to fetch real account balances.
    const horizonUrl =
      config.get<string>("HORIZON_URL") ??
      (this.network === Networks.PUBLIC
        ? "https://horizon.stellar.org"
        : "https://horizon-testnet.stellar.org");
    this.horizon = new Horizon.Server(horizonUrl);
    const secret = config.get<string>("KEEPER_SECRET_KEY");
    if (!secret) {
      throw new Error(
        "KEEPER_SECRET_KEY environment variable is required. " +
        "Generate a testnet keypair with: stellar keys generate keeper --network testnet"
      );
    }
    this.keeperKeypair = Keypair.fromSecret(secret);
  }

  /** Simulate a read-only contract invocation and return the result XDR. */
  async simulateInvoke(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<StellarRpc.Api.SimulateTransactionResponse> {
    const account = await this.withTimeout(
      this.rpc.getAccount(this.keeperKeypair.publicKey()),
      "getAccount",
    );
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.network,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    return this.withTimeout(
      this.rpc.simulateTransaction(tx),
      "simulateTransaction",
    );
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
    let lastSentHash: string | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Before retrying, check if the previous send already landed to avoid double-payout.
        if (attempt > 1 && lastSentHash) {
          try {
            const landedTx = await this.withTimeout(
              this.rpc.getTransaction(lastSentHash),
              "getTransaction (dedup check)",
            );
            if (landedTx.status === "SUCCESS") {
              this.logger.log(
                `invokeContract: previous send already landed — returning existing txHash=${lastSentHash} (attempt ${attempt})`,
              );
              return lastSentHash;
            }
          } catch {
            // getTransaction failed — proceed to retry the send
          }
        }

        // Re-fetch account on every attempt to get a fresh sequence number;
        // reusing a stale assembled transaction causes TRANSACTION_BAD_SEQ on retry.
        const account = await this.withTimeout(
          this.rpc.getAccount(signer.publicKey()),
          "getAccount",
        );
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.network,
        })
          .addOperation(contract.call(method, ...args))
          .setTimeout(30)
          .build();

        const simResult = await this.withTimeout(
          this.rpc.simulateTransaction(tx),
          "simulateTransaction",
        );
        if (StellarRpc.Api.isSimulationError(simResult)) {
          throw new SimulationFailedError(`Simulation failed: ${simResult.error}`);
        }

        const assembledTx = StellarRpc.assembleTransaction(
          tx,
          simResult,
        ).build();
        assembledTx.sign(signer);

        const sendResult = await this.withTimeout(
          this.rpc.sendTransaction(assembledTx),
          "sendTransaction",
        );
        // Capture hash before checking status so retry dedup can check if an ERROR-status
        // tx actually landed (RPC sometimes reports ERROR on submit but the tx still goes through).
        if (sendResult.hash) {
          lastSentHash = sendResult.hash;
        }
        if (sendResult.status === "ERROR") {
          throw new Error(
            `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`,
          );
        }
        // #183 — TRY_AGAIN_LATER means the RPC node's queue rejected the
        // submission outright: it was never broadcast, so waitForTransaction
        // would just poll for a hash that will never land until its own
        // timeout expires. Fail fast so the retry loop re-sends immediately
        // instead of burning up to 60s per attempt.
        if (sendResult.status === "TRY_AGAIN_LATER") {
          throw new Error(
            `Transaction submission was rejected by the RPC node (TRY_AGAIN_LATER) — not broadcast, retrying.`,
          );
        }
        // Wait for ledger close before returning so callers can trust the hash represents
        // a finalized on-chain state (PENDING → SUCCESS). Throws on FAILED, propagating
        // the failure correctly to callers instead of leaving the DB in a speculative PAID state.
        await this.waitForTransaction(sendResult.hash, 60_000);
        this.logger.log(
          `Contract invoked: ${contractId}.${method} → txHash=${sendResult.hash} (attempt ${attempt})`,
        );
        return sendResult.hash;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          `sendTransaction attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message}`,
        );
        // #187 — a reverting contract call is deterministic: the same
        // simulation will fail identically on every attempt, so retrying
        // it burns ~4-6s of backoff for nothing and hides the real revert
        // reason behind a generic "all attempts failed" message. Fail
        // fast instead; only genuine network/send errors get retried.
        if (err instanceof SimulationFailedError) {
          throw err;
        }
        if (attempt < MAX_ATTEMPTS) {
          // Exponential backoff: 2s, 4s, 8s...
          const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
          this.logger.warn(`Retrying in ${backoffMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
          await this.sleep(backoffMs);
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
    const simResult = await this.withTimeout(
      this.rpc.simulateTransaction(tx),
      "simulateTransaction",
    );
    if (StellarRpc.Api.isSimulationError(simResult)) {
      throw new SimulationFailedError(`Simulation failed: ${simResult.error}`);
    }

    const assembledTx = StellarRpc.assembleTransaction(tx, simResult).build();
    assembledTx.sign(this.keeperKeypair);

    const sendResult = await this.withTimeout(
      this.rpc.sendTransaction(assembledTx),
      "sendTransaction",
    );
    if (sendResult.status === "ERROR") {
      throw new Error(
        `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`,
      );
    }
    // #183 — TRY_AGAIN_LATER means the RPC node's queue rejected the
    // submission outright (never broadcast). This method returns the raw
    // send result to the caller with no waitForTransaction step of its own,
    // so silently treating TRY_AGAIN_LATER like PENDING/DUPLICATE here would
    // hand callers a hash that will never confirm as if it were in-flight.
    if (sendResult.status === "TRY_AGAIN_LATER") {
      throw new Error(
        `Transaction submission was rejected by the RPC node (TRY_AGAIN_LATER) — not broadcast.`,
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
      const txResult = await this.withTimeout(
        this.rpc.getTransaction(txHash),
        "getTransaction",
      );

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
   * Wraps a promise with a timeout. Rejects with a 504 Gateway Timeout error
   * if the operation does not complete within the specified time.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    operation: string,
    timeoutMs: number = 10000,
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.logger.warn(`RPC operation timed out after ${timeoutMs}ms: ${operation}`);
        reject(
          new HttpException(
            { message: `RPC operation timed out: ${operation}`, operation },
            HttpStatus.GATEWAY_TIMEOUT,
          ),
        );
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timer!);
      return result;
    } catch (err) {
      clearTimeout(timer!);
      throw err;
    }
  }

  /**
   * Get the native XLM balance for an account.
   * Used for keeper health checks to ensure the keeper has sufficient funds.
   */
  async getAccountBalance(publicKey: string): Promise<string> {
    const account = await this.withTimeout(
      this.horizon.loadAccount(publicKey),
      "loadAccount",
    );
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
