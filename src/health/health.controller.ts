import { Controller, Get, Inject, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiExtraModels } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { HealthResponseDto, HealthChecksDto, DatabaseCheckDto, StellarCheckDto, QueueCheckDto, ExternalApisDto, ExternalApiCheckDto, DatabasePoolDto, DatabaseThroughputDto, RedisMemoryDto, WorkerHeartbeatDto, DatabaseReplicationDto } from './dto/health-response.dto';
import { WORKER_HEARTBEATS } from '../common/worker-heartbeat';

// #191 — default floor below which the keeper account is considered too low
// to reliably keep paying transaction fees. Overridable via
// KEEPER_MIN_BALANCE_XLM for deployments with different fee/volume profiles.
const DEFAULT_KEEPER_MIN_BALANCE_XLM = 5;

// #338 — health checks are polled by load balancers/orchestrators expecting
// a response within 1-2s; the default 10s RPC timeout used elsewhere risked
// premature pod restarts whenever Horizon was merely slow, not down.
const HEALTH_CHECK_RPC_TIMEOUT_MS = 3000;

// Default replication lag threshold above which the database check is flagged
// as degraded. 50 MB is a reasonable ceiling for a parametric insurance backend
// where stale reads on claim/policy state must be bounded. Override via
// DB_REPLICATION_LAG_WARN_BYTES env var (bytes, integer).
const DEFAULT_REPLICATION_LAG_WARN_BYTES = 50 * 1024 * 1024; // 50 MB

// #426 — Lightweight probe URLs for external data providers.
// Open-Meteo: free API, no key — a minimal forecast request with a 1-day
//   window for the equator verifies HTTP reachability without side effects.
// AviationStack: key-gated — we send a minimal flights request; a 401/403
//   response still confirms the API endpoint itself is reachable (key
//   misconfiguration is surfaced separately via the `configured` flag).
const OPEN_METEO_HEALTH_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&daily=precipitation_sum&forecast_days=1&timezone=UTC';
const AVIATIONSTACK_HEALTH_URL =
  'https://api.aviationstack.com/v1/flights?flight_iata=AA1&access_key=';

@ApiTags('health')
@Controller('health')
@ApiExtraModels(HealthResponseDto, HealthChecksDto, DatabaseCheckDto, StellarCheckDto, QueueCheckDto, ExternalApisDto, ExternalApiCheckDto, DatabasePoolDto, DatabaseThroughputDto, RedisMemoryDto, WorkerHeartbeatDto, DatabaseReplicationDto)
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
   * Returns service health status including DB, Stellar, queue, and external
   * API dependency connectivity checks.
   *
   * Status codes:
   * - 200: All systems healthy
   * - 503: One or more dependencies are unavailable (DB, Stellar RPC, keeper,
   *        Redis, a stale background worker heartbeat, Open-Meteo, or AviationStack)
   */
  @Get()
  @ApiOperation({ summary: 'Check service health and dependency connectivity' })
  @ApiResponse({ status: 200, description: 'All systems healthy', type: HealthResponseDto })
  @ApiResponse({ status: 503, description: 'Service degraded (one or more dependencies unavailable)', type: HealthResponseDto })
  async check(): Promise<HealthResponseDto> {
    let dbStatus: 'ok' | 'error' = 'ok';
    let dbError: string | undefined;
    let dbPool: { active: number; idle: number; waiting: number } | undefined;
    let stellarStatus: 'ok' | 'error' = 'ok';
    let stellarError: string | undefined;
    let keeperBalanceXlm: string | undefined;
    // #441 — Direct Soroban RPC connectivity check fields
    let stellarRpcStatus: 'ok' | 'error' = 'ok';
    let stellarRpcLatencyMs: number | undefined;
    let stellarRpcLedger: number | undefined;
    let queueStatus: 'ok' | 'error' = 'ok';
    let queueError: string | undefined;

    // #426 — external API dependency statuses
    let openMeteoStatus: 'ok' | 'error' = 'ok';
    let openMeteoError: string | undefined;
    let aviationStackStatus: 'ok' | 'error' = 'ok';
    let aviationStackError: string | undefined;
    let aviationStackConfigured: boolean | undefined;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbStatus = 'error';
      this.logger.error(`Health check DB query failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // #444 — connection pool health: query pg_stat_activity so load balancers
    // can alert on pool exhaustion before queries start queuing or timing out.
    try {
      const rows = await this.prisma.$queryRaw<Array<{ state: string; count: bigint }>>`
        SELECT state, COUNT(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
        GROUP BY state
      `;
      dbPool = {
        active:  Number(rows.find(r => r.state === 'active')?.count  ?? 0),
        idle:    Number(rows.find(r => r.state === 'idle')?.count    ?? 0),
        waiting: Number(rows.find(r => r.state === 'idle in transaction (aborted)')?.count ?? 0),
      };
    } catch {
      // Non-fatal: pg_stat_activity may be restricted on managed databases.
    }

    // #441 — Direct Stellar RPC (Soroban) connectivity check.
    // getLatestLedger is the lightest available probe: it requires no
    // authentication, touches no account state, and always succeeds when
    // the RPC node is reachable. We record latency so ops can distinguish
    // a slow node from a fully unreachable one. A failure here is fatal
    // (stellarStatus → 'error') because contract invocations — claims,
    // policy submissions, oracle writes — all depend on the Soroban RPC.
    try {
      const rpcProbe = await this.stellar.checkRpcConnectivity(HEALTH_CHECK_RPC_TIMEOUT_MS);
      stellarRpcLatencyMs = rpcProbe.latencyMs;
      stellarRpcLedger    = rpcProbe.ledger;
    } catch (err) {
      stellarRpcStatus = 'error';
      stellarStatus    = 'error';
      stellarError     = `Stellar RPC unreachable: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.error(`Health check: ${stellarError}`);
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
      this.logger.error(`Health check Stellar keeper/Horizon failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // #403 — Redis/message queue connectivity check.
    // Background workers (claims, oracle) rely on Redis for job queuing and
    // distributed throttle storage; a silent Redis failure means those jobs
    // stop processing without any observable API-layer error. A PING here
    // surfaces the failure in the health endpoint so load balancers and
    // on-call alerts can react before users notice stuck claims or policies.
    let queueDepths: Record<string, number> | undefined;
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        queueStatus = 'error';
        queueError  = `Redis PING returned unexpected response: ${pong}`;
        this.logger.error(`Health check: ${queueError}`);
      } else {
        // #421 — Report waiting job counts for known Bull queues so ops can
        // detect build-up before processing latency becomes user-visible.
        const queueNames = (this.config.get<string>('HEALTH_QUEUE_NAMES') ?? 'claims,oracle')
          .split(',')
          .map(n => n.trim())
          .filter(Boolean);
        const depths = await Promise.all(
          queueNames.map(async (name) => [name, await this.redis.llen(`bull:${name}:wait`)] as [string, number]),
        );
        queueDepths = Object.fromEntries(depths);
      }
    } catch (err) {
      queueStatus = 'error';
      queueError  = err instanceof Error ? err.message : String(err);
      this.logger.error(`Health check Redis failed: ${queueError}`);
    }

    // Background worker (cron consumer) heartbeat check.
    // This repo's "consumers" are @Cron jobs (ClaimsWorker, OracleWorker,
    // AuthCleanupWorker), not a real Bull/BullMQ queue — the queueDepths
    // probe above reads `bull:*:wait` lists that nothing in this codebase
    // ever writes to, so it can't detect a stuck or crashed worker. Each
    // worker instead writes a heartbeat to Redis at the end of every
    // successful tick (see WORKER_HEARTBEATS); a missing key means the
    // worker hasn't completed a run within ~2x its expected interval.
    let workerHeartbeats: Record<string, { status: 'ok' | 'stale'; lastRunAt?: string }> | undefined;
    try {
      const workerNames = Object.keys(WORKER_HEARTBEATS) as Array<keyof typeof WORKER_HEARTBEATS>;
      const values = await this.redis.mget(...workerNames.map((name) => WORKER_HEARTBEATS[name].key));
      workerHeartbeats = Object.fromEntries(
        workerNames.map((name, i) => {
          const lastRunAt = values[i] ?? undefined;
          return [name, lastRunAt ? { status: 'ok' as const, lastRunAt } : { status: 'stale' as const }];
        }),
      );
      const staleWorkers = workerNames.filter((name) => workerHeartbeats![name].status === 'stale');
      if (staleWorkers.length > 0) {
        queueStatus = 'error';
        const staleMsg = `Stale worker heartbeat(s): ${staleWorkers.join(', ')}`;
        queueError  = queueError ? `${queueError}; ${staleMsg}` : staleMsg;
        this.logger.error(`Health check: ${staleMsg}`);
      }
    } catch (err) {
      this.logger.warn(`Failed to fetch worker heartbeats: ${err instanceof Error ? err.message : String(err)}`);
    }

    // #426 — Open-Meteo reachability check.
    // Open-Meteo is a free API with no authentication requirement. A minimal
    // forecast request (1-day window at lat/lng 0,0) confirms HTTP reachability
    // without consuming any quota. Any non-2xx response or network error is
    // flagged as degraded — oracle rainfall and temperature feeds will fail.
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_RPC_TIMEOUT_MS);
      try {
        const res = await fetch(OPEN_METEO_HEALTH_URL, { signal: controller.signal });
        if (!res.ok) {
          openMeteoStatus = 'error';
          openMeteoError  = `Open-Meteo responded with HTTP ${res.status}`;
          this.logger.error(`Health check: ${openMeteoError}`);
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      openMeteoStatus = 'error';
      openMeteoError  = err instanceof Error ? err.message : String(err);
      this.logger.error(`Health check Open-Meteo failed: ${openMeteoError}`);
    }

    // AviationStack reachability check.
    // Key-gated API: if no key is configured we still probe the endpoint
    // (with an empty access_key) so a 401/403 response confirms the API
    // itself is reachable, distinct from key misconfiguration which is
    // surfaced separately via the `configured` flag. Any network error or
    // 5xx/timeout is flagged as degraded — flight delay oracle reads will fail.
    aviationStackConfigured = !!this.config.get<string>('AVIATIONSTACK_API_KEY');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_RPC_TIMEOUT_MS);
      try {
        const res = await fetch(AVIATIONSTACK_HEALTH_URL, { signal: controller.signal });
        if (res.status >= 500) {
          aviationStackStatus = 'error';
          aviationStackError  = `AviationStack responded with HTTP ${res.status}`;
          this.logger.error(`Health check: ${aviationStackError}`);
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      aviationStackStatus = 'error';
      aviationStackError  = err instanceof Error ? err.message : String(err);
      this.logger.error(`Health check AviationStack failed: ${aviationStackError}`);
    }

    // #466 — Redis memory usage monitoring
    // Track Redis memory consumption to detect memory exhaustion before it
    // causes failures. Redis INFO memory command returns current memory usage,
    // peak usage, and configured max memory. Alert on high utilization.
    let redisMemory: { used: string; peak: string; maxmemory: string; usagePercent?: number } | undefined;
    try {
      const memInfo = await this.redis.info('memory');
      const lines = memInfo.split('\r\n');
      const used = lines.find(l => l.startsWith('used_memory_human:'))?.split(':')[1] || 'unknown';
      const peak = lines.find(l => l.startsWith('used_memory_peak_human:'))?.split(':')[1] || 'unknown';
      const maxmemory = lines.find(l => l.startsWith('maxmemory_human:'))?.split(':')[1] || 'unknown';
      const usedBytes = parseInt(lines.find(l => l.startsWith('used_memory:'))?.split(':')[1] || '0');
      const maxBytes = parseInt(lines.find(l => l.startsWith('maxmemory:'))?.split(':')[1] || '0');
      
      redisMemory = { used, peak, maxmemory };
      if (maxBytes > 0) {
        redisMemory.usagePercent = Math.round((usedBytes / maxBytes) * 100);
      }
    } catch (err) {
      this.logger.warn(`Failed to fetch Redis memory info: ${err instanceof Error ? err.message : String(err)}`);
    }

    // #463 — Database transaction throughput monitoring
    // Track database transaction rate to detect performance degradation.
    // pg_stat_database provides commit/rollback counters; delta between
    // health checks gives throughput. Performance issues surface as
    // declining commit rates or rising rollback ratios.
    let dbThroughput: { commits: number; rollbacks: number; conflicts: number } | undefined;
    try {
      const [stats] = await this.prisma.$queryRaw<Array<{ xact_commit: bigint; xact_rollback: bigint; conflicts: bigint }>>`
        SELECT xact_commit, xact_rollback, conflicts
        FROM pg_stat_database
        WHERE datname = current_database()
      `;
      if (stats) {
        dbThroughput = {
          commits: Number(stats.xact_commit),
          rollbacks: Number(stats.xact_rollback),
          conflicts: Number(stats.conflicts),
        };
      }
    } catch (err) {
      this.logger.warn(`Failed to fetch database throughput stats: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Replication lag monitoring — detect stale reads before they affect
    // claim/policy decisions. We query pg_stat_replication (primary-side view)
    // for streaming standbys' write/replay lag. On standby nodes we fall back
    // to pg_last_wal_receive_lsn vs pg_last_wal_replay_lsn. On a non-replicated
    // primary with no connected standbys both queries succeed but return no rows,
    // which we surface as lagBytes=0, standbyCount=0 (healthy — no replication
    // means no lag, but the operator should be aware). The check is non-fatal
    // (pg_stat_replication may be restricted on managed databases) but will
    // mark dbStatus='error' when lag exceeds DB_REPLICATION_LAG_WARN_BYTES.
    let dbReplication: DatabaseReplicationDto | undefined;
    try {
      const lagWarnBytes = Number(
        this.config.get<string>('DB_REPLICATION_LAG_WARN_BYTES') ?? DEFAULT_REPLICATION_LAG_WARN_BYTES,
      );

      // pg_stat_replication is only populated on the primary and only when at
      // least one standby is streaming. write_lag / replay_lag are INTERVAL
      // values (PostgreSQL ≥ 10); we extract epoch seconds via EXTRACT.
      const replicationRows = await this.prisma.$queryRaw<
        Array<{
          write_lag_seconds: number | null;
          replay_lag_seconds: number | null;
          sent_lsn: string;
          write_lsn: string;
          replay_lsn: string;
          lag_bytes: bigint;
        }>
      >`
        SELECT
          EXTRACT(EPOCH FROM write_lag)::float   AS write_lag_seconds,
          EXTRACT(EPOCH FROM replay_lag)::float  AS replay_lag_seconds,
          sent_lsn::text,
          write_lsn::text,
          replay_lsn::text,
          (pg_wal_lsn_diff(sent_lsn, replay_lsn))::bigint AS lag_bytes
        FROM pg_stat_replication
      `;

      if (replicationRows.length > 0) {
        // Aggregate across all standbys: take the worst (max) lag.
        const maxLagBytes = replicationRows.reduce(
          (max, row) => Math.max(max, Number(row.lag_bytes ?? 0)),
          0,
        );
        const maxLagSeconds = replicationRows.reduce(
          (max, row) => Math.max(max, Number(row.replay_lag_seconds ?? row.write_lag_seconds ?? 0)),
          0,
        );
        const lagExceedsThreshold = maxLagBytes > lagWarnBytes;

        dbReplication = {
          lagBytes:            maxLagBytes,
          lagSeconds:          maxLagSeconds,
          standbyCount:        replicationRows.length,
          lagExceedsThreshold,
        };

        if (lagExceedsThreshold) {
          dbStatus = 'error';
          const lagMB = (maxLagBytes / (1024 * 1024)).toFixed(1);
          dbError = dbError
            ? `${dbError}; Replication lag ${lagMB} MB exceeds threshold of ${(lagWarnBytes / (1024 * 1024)).toFixed(1)} MB`
            : `Replication lag ${lagMB} MB exceeds threshold of ${(lagWarnBytes / (1024 * 1024)).toFixed(1)} MB`;
          this.logger.error(`Health check: ${dbError}`);
        }
      } else {
        // No streaming standbys connected — either a standalone primary or a
        // standby where pg_stat_replication is empty. Try the standby-side view.
        const standbyRows = await this.prisma.$queryRaw<
          Array<{ receive_lsn: string | null; replay_lsn: string | null; lag_bytes: bigint | null }>
        >`
          SELECT
            pg_last_wal_receive_lsn()::text  AS receive_lsn,
            pg_last_wal_replay_lsn()::text   AS replay_lsn,
            pg_wal_lsn_diff(
              COALESCE(pg_last_wal_receive_lsn(), '0/0'),
              COALESCE(pg_last_wal_replay_lsn(),  '0/0')
            )::bigint AS lag_bytes
        `;

        const standbyLagBytes = Number(standbyRows[0]?.lag_bytes ?? 0);
        const lagExceedsThreshold = standbyLagBytes > lagWarnBytes;

        dbReplication = {
          lagBytes:            standbyLagBytes,
          lagSeconds:          null,
          standbyCount:        0,
          lagExceedsThreshold,
        };

        if (lagExceedsThreshold) {
          dbStatus = 'error';
          const lagMB = (standbyLagBytes / (1024 * 1024)).toFixed(1);
          dbError = dbError
            ? `${dbError}; Standby replication lag ${lagMB} MB exceeds threshold`
            : `Standby replication lag ${lagMB} MB exceeds threshold`;
          this.logger.error(`Health check: ${dbError}`);
        }
      }
    } catch (err) {
      // Non-fatal: pg_stat_replication and pg_last_wal_receive_lsn may be
      // restricted on managed databases (RDS, Cloud SQL, etc.) or not
      // applicable (SQLite/test environments). Log and continue.
      this.logger.warn(
        `Failed to fetch database replication stats: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const checks = {
      database: {
        status: dbStatus,
        ...(dbPool !== undefined ? { pool: dbPool } : {}),
        ...(dbThroughput !== undefined ? { throughput: dbThroughput } : {}),
        ...(dbReplication !== undefined ? { replication: dbReplication } : {}),
        ...(dbError ? { error: dbError } : {}),
      },
      stellar: {
        status: stellarStatus,
        rpcStatus: stellarRpcStatus,
        ...(stellarRpcLatencyMs !== undefined ? { rpcLatencyMs: stellarRpcLatencyMs } : {}),
        ...(stellarRpcLedger !== undefined ? { rpcLedger: stellarRpcLedger } : {}),
        ...(keeperBalanceXlm !== undefined ? { keeperBalanceXlm } : {}),
        ...(stellarError ? { error: stellarError } : {}),
      },
      queue: {
        status: queueStatus,
        ...(queueDepths !== undefined ? { depth: queueDepths } : {}),
        ...(redisMemory !== undefined ? { memory: redisMemory } : {}),
        ...(workerHeartbeats !== undefined ? { workers: workerHeartbeats } : {}),
        ...(queueError ? { error: queueError } : {}),
      },
      externalApis: {
        openMeteo: {
          status: openMeteoStatus,
          ...(openMeteoError ? { error: openMeteoError } : {}),
        },
        ...(aviationStackConfigured !== undefined
          ? {
              aviationStack: {
                status: aviationStackStatus,
                configured: aviationStackConfigured,
                ...(aviationStackError ? { error: aviationStackError } : {}),
              },
            }
          : {}),
      },
    };

    const healthy = 
      dbStatus === 'ok' && 
      stellarStatus === 'ok' && 
      queueStatus === 'ok' &&
      openMeteoStatus === 'ok' &&
      aviationStackStatus === 'ok';

    const body: HealthResponseDto = {
      status:    healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      service:   'parashield-api',
      checks: checks as any,
    };

    if (!healthy) {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return body;
  }
}
