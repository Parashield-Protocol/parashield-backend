import {
  ExceptionFilter, Catch, ArgumentsHost,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ErrorCode, errorCodeFromBody, errorCodeFromStatus } from '../errors/error-codes';
import { serializeBigInt } from '../interceptors/bigint-serializer.interceptor';
import { buildProblemDetails } from '../errors/problem-details';

interface PrismaErrorInfo {
  className: string;
  code?: string;
  meta?: Record<string, unknown>;
  stack?: string;
}

interface PrismaMapping {
  status: number;
  message: string;
  errorCode: ErrorCode;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const path = req.originalUrl || req.url;
    const correlationId = (req.headers['x-correlation-id'] || req.headers['x-request-id']) as string | undefined;

    // Check for Prisma errors (direct or wrapped as cause)
    const prismaInfo = this.extractPrismaError(exception);

    if (prismaInfo) {
      const mapping = this.mapPrismaError(prismaInfo);
      const status = mapping.status;
      const message = mapping.message;
      const errorCode = mapping.errorCode;

      // Log full detail once without request bodies, secrets, or connection strings
      this.logPrismaError(req.method, path, status, prismaInfo, correlationId);

      const problemBody = buildProblemDetails({
        status,
        message,
        error: status >= 500 ? 'Internal server error' : message,
        errorCode,
        path,
        correlationId,
      });

      res.setHeader('Content-Type', 'application/problem+json');
      res.status(status).json(serializeBigInt(problemBody));
      return;
    }

    // Standard HTTP and non-HTTP exception handling
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const rawResponse = exception instanceof HttpException
      ? exception.getResponse()
      : 'Internal server error';

    // Log the error once
    if (status >= 500) {
      this.logger.error(
        `${req.method} ${path} → ${status}${correlationId ? ` [corr: ${correlationId}]` : ''}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `${req.method} ${path} → ${status}${correlationId ? ` [corr: ${correlationId}]` : ''}`,
      );
    }

    // Extract human-readable string message
    const message = this.extractMessage(rawResponse);

    // Extract retryAfter header for 429 rate limit responses
    const retryAfter = this.extractRetryAfter(rawResponse);

    // Extract field-level validation errors from class-validator ValidationPipe
    const errors = this.extractValidationErrors(rawResponse);

    const errorCode = errorCodeFromBody(rawResponse) ?? errorCodeFromStatus(status);

    // #677 — Adopt RFC 7807 problem details with Content-Type application/problem+json.
    const problemBody = buildProblemDetails({
      status,
      message,
      error: status >= 500 ? 'Internal server error' : message,
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
   * Robustly detect if an error is a Prisma error class, or if it wraps one.
   * Uses both instanceof checks against installed Prisma error classes and
   * duck-typing fallbacks for cross-boundary/bundling robustness.
   */
  private extractPrismaError(exception: unknown): PrismaErrorInfo | null {
    if (!exception) return null;

    // Check if exception itself is a Prisma error
    const direct = this.inspectPrismaError(exception);
    if (direct) return direct;

    // Check if exception has a cause (e.g., standard Error.cause or HttpException.cause)
    if (typeof exception === 'object' && exception !== null && 'cause' in exception) {
      const cause = (exception as { cause?: unknown }).cause;
      const fromCause = this.extractPrismaError(cause);
      if (fromCause) return fromCause;
    }

    // Check if an HttpException message or response contains a leaked Prisma code or signature
    if (exception instanceof HttpException) {
      const raw = exception.getResponse();
      const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const match = rawStr.match(/\b(P2\d{3})\b/);
      if (match) {
        return {
          className: 'PrismaClientKnownRequestError',
          code: match[1],
          stack: exception.stack,
        };
      }
    }

    return null;
  }

  private inspectPrismaError(err: unknown): PrismaErrorInfo | null {
    if (!err || typeof err !== 'object') return null;

    const errorObj = err as Record<string, unknown>;
    const name = typeof errorObj.name === 'string' ? errorObj.name : '';
    const stack = typeof errorObj.stack === 'string' ? errorObj.stack : undefined;

    // 1. PrismaClientKnownRequestError
    if (
      err instanceof Prisma.PrismaClientKnownRequestError ||
      name === 'PrismaClientKnownRequestError' ||
      (typeof errorObj.code === 'string' && /^P\d{4}$/.test(errorObj.code))
    ) {
      return {
        className: 'PrismaClientKnownRequestError',
        code: errorObj.code as string,
        meta: (errorObj.meta as Record<string, unknown>) ?? undefined,
        stack,
      };
    }

    // 2. PrismaClientValidationError
    if (
      err instanceof Prisma.PrismaClientValidationError ||
      name === 'PrismaClientValidationError'
    ) {
      return {
        className: 'PrismaClientValidationError',
        stack,
      };
    }

    // 3. PrismaClientInitializationError
    if (
      err instanceof Prisma.PrismaClientInitializationError ||
      name === 'PrismaClientInitializationError'
    ) {
      return {
        className: 'PrismaClientInitializationError',
        code: typeof errorObj.errorCode === 'string' ? (errorObj.errorCode as string) : undefined,
        stack,
      };
    }

    // 4. PrismaClientUnknownRequestError
    if (
      err instanceof Prisma.PrismaClientUnknownRequestError ||
      name === 'PrismaClientUnknownRequestError'
    ) {
      return {
        className: 'PrismaClientUnknownRequestError',
        stack,
      };
    }

    // 5. PrismaClientRustPanicError
    if (
      err instanceof Prisma.PrismaClientRustPanicError ||
      name === 'PrismaClientRustPanicError'
    ) {
      return {
        className: 'PrismaClientRustPanicError',
        stack,
      };
    }

    return null;
  }

  /**
   * Map Prisma errors to generic, safe status codes and messages.
   * Never leaks constraint names, column names, model names, or Prisma codes.
   */
  private mapPrismaError(info: PrismaErrorInfo): PrismaMapping {
    switch (info.className) {
      case 'PrismaClientKnownRequestError':
        return this.mapKnownRequestError(info.code);

      case 'PrismaClientValidationError':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'Invalid data provided for database operation.',
          errorCode: ErrorCode.BAD_REQUEST,
        };

      case 'PrismaClientInitializationError':
        return {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Database service is temporarily unavailable. Please try again later.',
          errorCode: ErrorCode.SERVICE_UNAVAILABLE,
        };

      case 'PrismaClientUnknownRequestError':
      case 'PrismaClientRustPanicError':
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'An unexpected database error occurred. Please try again later.',
          errorCode: ErrorCode.INTERNAL_ERROR,
        };
    }
  }

  private mapKnownRequestError(code?: string): PrismaMapping {
    switch (code) {
      // Unique constraint violation (duplicate record)
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          message: 'A resource with conflicting unique attributes already exists.',
          errorCode: ErrorCode.CONFLICT,
        };

      // Foreign key constraint violation
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          message: 'The requested operation violates an existing relationship constraint.',
          errorCode: ErrorCode.CONFLICT,
        };

      // Required relation violation
      case 'P2014':
        return {
          status: HttpStatus.CONFLICT,
          message: 'The requested operation violates a model relation constraint.',
          errorCode: ErrorCode.CONFLICT,
        };

      // Transaction conflict / serialization failure / deadlock
      case 'P2034':
        return {
          status: HttpStatus.CONFLICT,
          message: 'A concurrent modification conflict occurred. Please retry your request.',
          errorCode: ErrorCode.CONFLICT,
        };

      // Record not found
      case 'P2025':
      case 'P2015':
      case 'P2018':
        return {
          status: HttpStatus.NOT_FOUND,
          message: 'The requested resource was not found.',
          errorCode: ErrorCode.NOT_FOUND,
        };

      // Input / length / null / invalid value errors
      case 'P2000':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'The provided value exceeds the maximum allowed length.',
          errorCode: ErrorCode.BAD_REQUEST,
        };
      case 'P2005':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'The provided value is invalid for the field type.',
          errorCode: ErrorCode.BAD_REQUEST,
        };
      case 'P2006':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'The provided value is not valid.',
          errorCode: ErrorCode.BAD_REQUEST,
        };
      case 'P2011':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'A required field was missing or null.',
          errorCode: ErrorCode.BAD_REQUEST,
        };
      case 'P2012':
      case 'P2013':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'A required field was missing.',
          errorCode: ErrorCode.BAD_REQUEST,
        };
      case 'P2016':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'Invalid query parameters provided.',
          errorCode: ErrorCode.BAD_REQUEST,
        };
      case 'P2017':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'The related records are not connected.',
          errorCode: ErrorCode.BAD_REQUEST,
        };

      // Connection pool timeout
      case 'P2024':
        return {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Database service is temporarily unavailable. Please try again later.',
          errorCode: ErrorCode.SERVICE_UNAVAILABLE,
        };

      // All unmapped known codes (e.g. P2021 table not found, P2022 column not found, P2028 transaction error)
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'An unexpected database error occurred. Please try again later.',
          errorCode: ErrorCode.INTERNAL_ERROR,
        };
    }
  }

  /**
   * Log full Prisma error details once through existing logger.
   * Connection strings, passwords, and secrets are scrubbed.
   */
  private logPrismaError(
    method: string,
    path: string,
    status: number,
    info: PrismaErrorInfo,
    correlationId?: string,
  ): void {
    const sanitizedMeta = this.sanitizeMeta(info.meta);
    const corrTag = correlationId ? ` [corr: ${correlationId}]` : '';
    const codeTag = info.code ? ` (${info.code})` : '';
    const metaTag = sanitizedMeta ? ` meta=${sanitizedMeta}` : '';

    const logLine = `[Prisma ${info.className}${codeTag}] ${method} ${path} → ${status}${corrTag}${metaTag}`;

    if (status >= 500) {
      this.logger.error(logLine, info.stack);
    } else {
      this.logger.warn(logLine);
    }
  }

  private sanitizeMeta(meta: unknown): string {
    if (!meta || typeof meta !== 'object') return '';
    try {
      const json = JSON.stringify(meta);
      return json.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgres://***:***@');
    } catch {
      return '[Unserializable meta]';
    }
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
