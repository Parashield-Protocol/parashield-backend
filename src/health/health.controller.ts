import { Controller, Get, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /api/v1/health
   * Returns service health status including DB connectivity check.
   */
  @Get()
  @ApiOperation({ summary: 'Check service health and database connectivity' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  @ApiResponse({ status: 503, description: 'Service is degraded (DB unreachable)' })
  async check() {
    let dbStatus: 'ok' | 'error' = 'ok';
    let dbError: string | undefined;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbStatus = 'error';
      dbError  = err instanceof Error ? err.message : String(err);
      this.logger.error(`Health check DB query failed: ${dbError}`);
    }

    const healthy = dbStatus === 'ok';

    const body = {
      status:    healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      service:   'parashield-api',
      checks: {
        database: {
          status: dbStatus,
          ...(dbError ? { error: dbError } : {}),
        },
      },
    };

    if (!healthy) {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return body;
  }
}
