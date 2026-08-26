import { Controller, Get, Inject, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';

// #191 — default floor below which the keeper account is considered too low
// to reliably keep paying transaction fees. Overridable via
// KEEPER_MIN_BALANCE_XLM for deployments with different fee/volume profiles.
const DEFAULT_KEEPER_MIN_BALANCE_XLM = 5;

// #338 — health checks are polled by load balancers/orchestrators expecting
// a response within 1-2s; the default 10s RPC timeout used elsewhere risked
// premature pod restarts whenever Horizon was merely slow, not down.
const HEALTH_CHECK_RPC_TIMEOUT_MS = 3000;

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly config: ConfigService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  /**
   * GET /api/v1/health
   * Returns service health status including DB and Stellar connectivity checks.
   *
   * Status codes:
   * - 200: All systems healthy
   * - 503: One or more dependencies are unavailable (DB, Stellar RPC, or keeper)
   */
  @Get()
  @ApiOperation({ summary: 'Check service health and dependency connectivity' })
  @ApiResponse({ status: 200, description: 'All systems healthy' })
  @ApiResponse({ status: 503, description: 'Service degraded (one or more dependencies unavailable)' })
  async check() {
    let dbStatus: 'ok' | 'error' = 'ok';
    let dbError: string | undefined;
    let stellarStatus: 'ok' | 'error' = 'ok';
    let stellarError: string | undefined;
    let keeperBalanceXlm: string | undefined;
    let queueStatus: 'ok' | 'error' = 'ok';
    let queueError: string | undefined;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbStatus = 'error';
      this.logger.error(`Health check DB query failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      keeperBalanceXlm = await this.stellar.getAccountBalance(
        this.stellar.keeperKeypair.publicKey(),
        HEALTH_CHECK_RPC_TIMEOUT_MS,
      );

      // #191 — RPC reachability alone isn't enough: a keeper account
      // drained of XLM would still answer this call successfully (with a
      // low/zero balance) while every real claim/policy submission fails
      // to cover its transaction fee. Flag degraded once balance drops
      // below a configurable floor, not just on outright RPC failure.
      const minBalance = Number(
        this.config.get<string>('KEEPER_MIN_BALANCE_XLM') ?? DEFAULT_KEEPER_MIN_BALANCE_XLM,
      );
      if (Number(keeperBalanceXlm) < minBalance) {
        stellarStatus = 'error';
        stellarError  = `Keeper balance ${keeperBalanceXlm} XLM is below the minimum floor of ${minBalance} XLM`;
        this.logger.error(`Health check: ${stellarError}`);
      }
    } catch (err) {
      stellarStatus = 'error';
      this.logger.error(`Health check Stellar RPC failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // #403 — Redis/message queue connectivity check.
    // Background workers (claims, oracle) rely on Redis for job queuing and
    // distributed throttle storage; a silent Redis failure means those jobs
    // stop processing without any observable API-layer error. A PING here
    // surfaces the failure in the health endpoint so load balancers and
    // on-call alerts can react before users notice stuck claims or policies.
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        queueStatus = 'error';
        queueError  = `Redis PING returned unexpected response: ${pong}`;
        this.logger.error(`Health check: ${queueError}`);
      }
    } catch (err) {
      queueStatus = 'error';
      queueError  = err instanceof Error ? err.message : String(err);
      this.logger.error(`Health check Redis failed: ${queueError}`);
    }

    const healthy = dbStatus === 'ok' && stellarStatus === 'ok' && queueStatus === 'ok';

    const body = {
      status:    healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      service:   'parashield-api',
      checks: {
        database: {
          status: dbStatus,
          ...(dbError ? { error: dbError } : {}),
        },
        stellar: {
          status: stellarStatus,
          ...(keeperBalanceXlm !== undefined ? { keeperBalanceXlm } : {}),
          ...(stellarError ? { error: stellarError } : {}),
        },
        queue: {
          status: queueStatus,
          ...(queueError ? { error: queueError } : {}),
        },
      },
    };

    if (!healthy) {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return body;
  }
}
