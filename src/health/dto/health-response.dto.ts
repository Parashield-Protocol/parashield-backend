import { ApiProperty } from '@nestjs/swagger';

export class DatabasePoolDto {
  @ApiProperty({ description: 'Number of active connections' })
  active: number;

  @ApiProperty({ description: 'Number of idle connections' })
  idle: number;

  @ApiProperty({ description: 'Number of waiting connections' })
  waiting: number;

  @ApiProperty({ description: 'Configured maximum pool size (DATABASE_CONNECTION_LIMIT, default 10)', example: 10 })
  max: number;

  @ApiProperty({ description: 'Active connections as a percentage of the configured max pool size', example: 30 })
  utilizationPercent: number;

  @ApiProperty({
    description: 'Whether utilization has met or exceeded the exhaustion warning threshold (DB_POOL_EXHAUSTION_WARN_PERCENT, default 90%)',
    example: false,
  })
  exhausted: boolean;
}

export class DatabaseThroughputDto {
  @ApiProperty({ description: 'Total committed transactions' })
  commits: number;

  @ApiProperty({ description: 'Total rolled back transactions' })
  rollbacks: number;

  @ApiProperty({ description: 'Total transaction conflicts' })
  conflicts: number;
}

export class DatabaseReplicationDto {
  @ApiProperty({ description: 'Replication lag in bytes (WAL bytes not yet applied on standby); 0 on primary-only setups or when no standby is connected', example: 0 })
  lagBytes: number;

  @ApiProperty({
    description: 'Replication lag in seconds derived from pg_last_wal_receive_lsn vs pg_last_wal_replay_lsn on the standby, or from write_lag/replay_lag on the primary pg_stat_replication view. null when not measurable (e.g. primary with no streaming standbys)',
    example: 0,
    nullable: true,
    required: false,
  })
  lagSeconds?: number | null;

  @ApiProperty({ description: 'Number of connected streaming standbys', example: 1 })
  standbyCount: number;

  @ApiProperty({
    description: 'Whether lag exceeds the configured threshold (DB_REPLICATION_LAG_WARN_BYTES, default 50 MB)',
    example: false,
  })
  lagExceedsThreshold: boolean;
}

export class DatabaseCheckDto {
  @ApiProperty({ description: 'Database connectivity status', enum: ['ok', 'error'] })
  status: 'ok' | 'error';

  @ApiProperty({ description: 'Connection pool statistics', type: DatabasePoolDto, required: false })
  pool?: DatabasePoolDto;

  @ApiProperty({ description: 'Transaction throughput statistics', type: DatabaseThroughputDto, required: false })
  throughput?: DatabaseThroughputDto;

  @ApiProperty({ description: 'Replication lag statistics (absent on non-replicated or restricted setups)', type: DatabaseReplicationDto, required: false })
  replication?: DatabaseReplicationDto;

  @ApiProperty({ description: 'Error message when status is "error"', required: false })
  error?: string;
}

export class StellarNetworkCheckDto {
  @ApiProperty({ description: 'Whether the Stellar network is operational and matches the configured network', enum: ['ok', 'error'] })
  status: 'ok' | 'error';

  @ApiProperty({ description: 'Health reported by the Stellar RPC node (e.g. "healthy")', required: false })
  rpcHealth?: string;

  @ApiProperty({ description: 'Current Stellar protocol version', required: false })
  protocolVersion?: number;

  @ApiProperty({ description: 'Whether the RPC network passphrase matches the configured STELLAR_NETWORK', required: false })
  passphraseMatches?: boolean;
}

export class StellarCheckDto {
  @ApiProperty({ description: 'Stellar RPC/keeper connectivity status', enum: ['ok', 'error'] })
  status: 'ok' | 'error';

  @ApiProperty({ description: 'Keeper account native XLM balance (7-decimal fixed point)', required: false })
  keeperBalanceXlm?: string;

  @ApiProperty({ description: 'Stellar RPC (Soroban) connectivity status', enum: ['ok', 'error'], required: false })
  rpcStatus?: 'ok' | 'error';

  @ApiProperty({ description: 'Stellar RPC round-trip latency in milliseconds', required: false })
  rpcLatencyMs?: number;

  @ApiProperty({ description: 'Latest ledger sequence number returned by Stellar RPC', required: false })
  rpcLedger?: number;

  @ApiProperty({ description: 'Stellar network operational status (#474)', type: StellarNetworkCheckDto, required: false })
  network?: StellarNetworkCheckDto;

  @ApiProperty({ description: 'Error message when status is "error"', required: false })
  error?: string;
}

export class RedisMemoryDto {
  @ApiProperty({ description: 'Current memory usage (human readable)' })
  used: string;

  @ApiProperty({ description: 'Peak memory usage (human readable)' })
  peak: string;

  @ApiProperty({ description: 'Maximum configured memory (human readable)' })
  maxmemory: string;

  @ApiProperty({ description: 'Memory usage percentage', required: false })
  usagePercent?: number;
}

export class WorkerHeartbeatDto {
  @ApiProperty({ description: 'Whether the worker completed a run within its expected interval', enum: ['ok', 'stale'] })
  status: 'ok' | 'stale';

  @ApiProperty({ description: 'Timestamp of the worker\'s last completed run (ISO 8601)', required: false })
  lastRunAt?: string;
}

export class QueueCheckDto {
  @ApiProperty({ description: 'Redis connectivity status', enum: ['ok', 'error'] })
  status: 'ok' | 'error';

  @ApiProperty({ description: 'Queue depths by queue name', required: false })
  depth?: Record<string, number>;

  @ApiProperty({ description: 'Redis memory statistics', type: RedisMemoryDto, required: false })
  memory?: RedisMemoryDto;

  @ApiProperty({ description: 'Background worker (cron consumer) liveness by worker name', type: WorkerHeartbeatDto, required: false })
  workers?: Record<string, WorkerHeartbeatDto>;

  @ApiProperty({ description: 'Error message when status is "error"', required: false })
  error?: string;
}

export class ExternalApiCheckDto {
  @ApiProperty({ description: 'External API status', enum: ['ok', 'error'] })
  status: 'ok' | 'error';

  @ApiProperty({ description: 'API configured status', required: false })
  configured?: boolean;

  @ApiProperty({ description: 'Error message when status is "error"', required: false })
  error?: string;
}

export class ExternalApisDto {
  @ApiProperty({ type: ExternalApiCheckDto })
  openMeteo: ExternalApiCheckDto;

  @ApiProperty({ type: ExternalApiCheckDto, required: false })
  aviationStack?: ExternalApiCheckDto;
}

export class HealthChecksDto {
  @ApiProperty({ type: DatabaseCheckDto })
  database: DatabaseCheckDto;

  @ApiProperty({ type: StellarCheckDto })
  stellar: StellarCheckDto;

  @ApiProperty({ type: QueueCheckDto })
  queue: QueueCheckDto;

  @ApiProperty({ type: ExternalApisDto })
  externalApis: ExternalApisDto;
}

export class DependencyVersionsDto {
  @ApiProperty({ example: '15.0' }) database: string;
  @ApiProperty({ example: '7.2.0' }) redis: string;
  @ApiProperty({ example: '13.0.0' }) stellarSdk: string;
}

export class HealthResponseDto {
  @ApiProperty({ description: 'Overall service health', enum: ['ok', 'degraded'] })
  status: 'ok' | 'degraded';

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp: string;

  @ApiProperty({ description: 'Service identifier', example: 'parashield-api' })
  service: string;

  @ApiProperty({ description: 'Application version from package.json', example: '0.1.0' })
  version: string;

  @ApiProperty({ description: 'Total health check duration in milliseconds', example: 125 })
  responseTimeMs: number;

  @ApiProperty({ type: HealthChecksDto })
  checks: HealthChecksDto;

  @ApiProperty({ type: DependencyVersionsDto })
  versions: DependencyVersionsDto;
}
