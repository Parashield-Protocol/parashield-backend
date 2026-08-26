import {
  ExceptionFilter, Catch, ArgumentsHost,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { errorCodeFromStatus } from '../errors/error-codes';

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

    // #425 — Normalize the error message to always be a plain string so the
    // client never has to branch on typeof error. NestJS HttpException bodies
    // can be strings or objects ({ statusCode, message, error }); class-validator
    // ValidationPipe produces { statusCode, message: string[], error } objects.
    // We extract the most descriptive string available in each case.
    const message = this.extractMessage(rawResponse);

    // #402 — include a stable machine-readable errorCode so the frontend
    // can branch on error type without parsing the human-readable message.
    // #425 — retryAfter is promoted to the top level so clients never need
    // to dig into a nested error object to get the value they act on.
    const retryAfter = this.extractRetryAfter(rawResponse);

    // #341 — success responses across controllers use { success, data },
    // so error responses carry the same success flag (always false here)
    // with the message under `error`, instead of a differently shaped
    // { statusCode, message } body the frontend had to special-case.
    const body: Record<string, unknown> = {
      success:    false,
      errorCode:  errorCodeFromStatus(status),
      error:      message,
      statusCode: status,
      path:       req.url,
      timestamp:  new Date().toISOString(),
    };

    if (retryAfter !== undefined) {
      body['retryAfter'] = retryAfter;
    }

    res.status(status).json(body);
  }

  /**
   * Reduce an HttpException response to a human-readable string.
   *
   * Priority order:
   *  1. Plain string body  → use directly
   *  2. Object with a string `message` property → use that string
   *  3. Object with an array `message` property (class-validator) → join with "; "
   *  4. Anything else → JSON.stringify as a last resort
   */
  private extractMessage(raw: string | object): string {
    if (typeof raw === 'string') return raw;

    const obj = raw as Record<string, unknown>;

    if (typeof obj['message'] === 'string') return obj['message'];

    if (Array.isArray(obj['message'])) {
      return (obj['message'] as unknown[])
        .map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
        .join('; ');
    }

    return JSON.stringify(raw);
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
