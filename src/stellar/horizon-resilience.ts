import { HttpException, HttpStatus, Logger } from "@nestjs/common";
import { ErrorCode } from "../common/errors/error-codes";

/**
 * Horizon timeout handling — retry with exponential backoff, a typed error on
 * final failure, and a circuit breaker that fails fast once Horizon has timed
 * out repeatedly. Previously a slow Horizon surfaced as an untyped timeout
 * exception on the first attempt, turning a transient network blip into a 500.
 */

/** Thrown when every attempt of a Horizon call timed out. Maps to 504. */
export class HorizonTimeoutError extends HttpException {
  constructor(
    readonly operation: string,
    readonly attempts: number,
    readonly timeoutMs: number,
  ) {
    super(
      {
        message: `Stellar Horizon request "${operation}" timed out after ${attempts} attempt(s) (${timeoutMs}ms each)`,
        errorCode: ErrorCode.HORIZON_TIMEOUT,
      },
      HttpStatus.GATEWAY_TIMEOUT,
    );
    this.name = "HorizonTimeoutError";
  }
}

/** Thrown without calling Horizon while the timeout circuit is open. Maps to 503. */
export class HorizonUnavailableError extends HttpException {
  constructor(readonly operation: string, readonly retryAfterMs: number) {
    super(
      {
        message: `Stellar Horizon is temporarily unavailable (circuit open after repeated timeouts) — "${operation}" not attempted`,
        errorCode: ErrorCode.HORIZON_UNAVAILABLE,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = "HorizonUnavailableError";
  }
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
]);

function statusOf(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status
    ?? (err as { status?: number })?.status;
}

/** True for our own withTimeout rejection and for socket/axios-level timeouts. */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof HorizonTimeoutError) return true;
  if (err instanceof HttpException && err.getStatus() === HttpStatus.GATEWAY_TIMEOUT) return true;
  const code = (err as { code?: string })?.code;
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /timed? ?out/i.test(message);
}

/**
 * Timeouts, network failures, 429s and 5xx responses are worth retrying.
 * Other 4xx responses (e.g. 404 account not found) are deterministic and are
 * rethrown immediately so callers can handle them.
 */
export function isRetryableHorizonError(err: unknown): boolean {
  if (isTimeoutError(err)) return true;
  const status = statusOf(err);
  if (typeof status === "number") return status === 429 || status >= 500;
  const code = (err as { code?: string })?.code;
  return typeof code === "string" && NETWORK_ERROR_CODES.has(code);
}

/**
 * Counts consecutive Horizon calls that exhausted their retries on timeouts.
 * At `threshold` the circuit opens and calls fail fast for `resetTimeoutMs`;
 * after that a single probe is let through — its outcome closes or reopens
 * the circuit.
 */
export class HorizonCircuitBreaker {
  private consecutiveTimeouts = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;
  private readonly logger = new Logger("CircuitBreaker:horizon");

  constructor(
    private readonly threshold: number = 3,
    private readonly resetTimeoutMs: number = 30_000,
  ) {}

  get isOpen(): boolean {
    return this.openedAt !== null;
  }

  /** Throws HorizonUnavailableError if the call must not reach Horizon. */
  acquire(operation: string): void {
    if (this.openedAt === null) return;
    const elapsed = Date.now() - this.openedAt;
    if (elapsed < this.resetTimeoutMs || this.probeInFlight) {
      throw new HorizonUnavailableError(operation, Math.max(this.resetTimeoutMs - elapsed, 0));
    }
    this.probeInFlight = true;
    this.logger.warn(`Circuit half-open — allowing probe "${operation}"`);
  }

  /** Horizon answered within the deadline (success or a non-timeout error). */
  recordResponse(): void {
    if (this.openedAt !== null) this.logger.log("Probe succeeded — circuit closed");
    this.consecutiveTimeouts = 0;
    this.openedAt = null;
    this.probeInFlight = false;
  }

  /** A call exhausted its retries on timeouts. */
  recordTimeout(): void {
    this.probeInFlight = false;
    this.consecutiveTimeouts++;
    if (this.openedAt !== null || this.consecutiveTimeouts >= this.threshold) {
      this.openedAt = Date.now();
      this.logger.error(
        `Circuit opened after ${this.consecutiveTimeouts} consecutive Horizon timeouts — failing fast for ${this.resetTimeoutMs}ms`,
      );
    }
  }
}
