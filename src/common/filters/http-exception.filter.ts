import {
  ExceptionFilter, Catch, ArgumentsHost,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { errorCodeFromBody, errorCodeFromStatus } from '../errors/error-codes';
import { serializeBigInt } from '../interceptors/bigint-serializer.interceptor';
import { buildProblemDetails } from '../errors/problem-details';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx    = host.switchToHttp();
    const res    = ctx.getResponse<Response>();
    const req    = ctx.getRequest<Request>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const rawResponse = exception instanceof HttpException
      ? exception.getResponse()
      : 'Internal server error';

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${req.method} ${req.url} → ${status}`);
    }

    // Extract human-readable string message
    const message = this.extractMessage(rawResponse);

    // Extract retryAfter header for 429 rate limit responses
    const retryAfter = this.extractRetryAfter(rawResponse);

    // Extract field-level validation errors from class-validator ValidationPipe
    const errors = this.extractValidationErrors(rawResponse);

    // Extract optional correlation ID if present on request
    const correlationId = (req.headers['x-correlation-id'] || req.headers['x-request-id']) as string | undefined;

    const errorCode = errorCodeFromBody(rawResponse) ?? errorCodeFromStatus(status);
    const path = req.originalUrl || req.url;

    // #677 — Adopt RFC 7807 problem details with Content-Type application/problem+json.
    // Includes type, title, status, detail, instance, extension members (errors, correlationId),
    // and preserves legacy fields (success, statusCode, error, message, errorCode, path, timestamp)
    // for backward compatibility.
    const problemBody = buildProblemDetails({
      status,
      message,
      error: message,
      errorCode,
      path,
      errors,
      correlationId,
      retryAfter,
    });

    res.setHeader('Content-Type', 'application/problem+json');
    res.status(status).json(serializeBigInt(problemBody));
  }

  /**
   * Reduce an HttpException response to a human-readable string.
   */
  private extractMessage(raw: string | object): string {
    if (typeof raw === 'string') return raw;

    const obj = raw as Record<string, unknown>;

    if (typeof obj['message'] === 'string') return obj['message'];

    if (Array.isArray(obj['message'])) {
      return (obj['message'] as unknown[])
        .map((m) => (typeof m === 'string' ? m : JSON.stringify(serializeBigInt(m))))
        .join('; ');
    }

    return JSON.stringify(serializeBigInt(raw));
  }

  /**
   * Extract validation error list from ValidationPipe response objects.
   */
  private extractValidationErrors(raw: string | object): unknown {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj['message'])) {
      return obj['message'];
    }
    if (Array.isArray(obj['errors'])) {
      return obj['errors'];
    }
    return undefined;
  }

  /**
   * Pull retryAfter out of a ThrottleGuard body `{ retryAfter: number }`,
   * or return undefined for all other exception types.
   */
  private extractRetryAfter(raw: string | object): number | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const val = (raw as Record<string, unknown>)['retryAfter'];
    return typeof val === 'number' ? val : undefined;
  }
}

