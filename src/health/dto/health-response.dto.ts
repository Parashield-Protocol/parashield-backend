import { ApiProperty } from '@nestjs/swagger';

export class DatabasePoolDto {
  @ApiProperty({ description: 'Number of active connections' })
  active: number;

  @ApiProperty({ description: 'Number of idle connections' })
  idle: number;

  @ApiProperty({ description: 'Number of waiting connections' })
  waiting: number;
}

export class DatabaseThroughputDto {
  @ApiProperty({ description: 'Total committed transactions' })
  commits: number;

  @ApiProperty({ description: 'Total rolled back transactions' })
  rollbacks: number;

  @ApiProperty({ description: 'Total transaction conflicts' })
  conflicts: number;
}

export class DatabaseCheckDto {
  @ApiProperty({ description: 'Database connectivity status', enum: ['ok', 'error'] })
  status: 'ok' | 'error';

  @ApiProperty({ description: 'Connection pool statistics', type: DatabasePoolDto, required: false })
  pool?: DatabasePoolDto;

  @ApiProperty({ description: 'Transaction throughput statistics', type: DatabaseThroughputDto, required: false })
  throughput?: DatabaseThroughputDto;

  @ApiProperty({ description: 'Error message when status is "error"', required: false })
  error?: string;
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

export class HealthResponseDto {
  @ApiProperty({ description: 'Overall service health', enum: ['ok', 'degraded'] })
  status: 'ok' | 'degraded';

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp: string;

  @ApiProperty({ description: 'Service identifier', example: 'parashield-api' })
  service: string;

  @ApiProperty({ type: HealthChecksDto })
  checks: HealthChecksDto;
}
