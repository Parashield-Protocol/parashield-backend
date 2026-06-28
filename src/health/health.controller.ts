import { Controller, Get, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
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

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbStatus = 'error';
      dbError  = err instanceof Error ? err.message : String(err);
      this.logger.error(`Health check DB query failed: ${dbError}`);
    }

    try {
      await this.stellar.getAccountBalance(this.stellar.keeperKeypair.publicKey());
    } catch (err) {
      stellarStatus = 'error';
      stellarError  = err instanceof Error ? err.message : String(err);
      this.logger.error(`Health check Stellar RPC failed: ${stellarError}`);
    }

    const healthy = dbStatus === 'ok' && stellarStatus === 'ok';

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
          ...(stellarError ? { error: stellarError } : {}),
        },
      },
    };

    if (!healthy) {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return body;
  }
}
