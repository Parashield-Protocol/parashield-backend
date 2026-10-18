import { Injectable, NestInterceptor, ExecutionContext, CallHandler, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import {
  SUPPORTED_API_VERSIONS,
  applyApiVersionHeaders,
  apiVersionHeaderValue,
  isSupportedVersion,
  resolveRequestedVersion,
} from '../versioning/api-version';

@Injectable()
export class VersioningInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const path = request.originalUrl || request.url || request.path;
    const header = request.headers?.['x-api-version'];
    const version = resolveRequestedVersion(
      path,
      Array.isArray(header) ? header[0] : header,
    );

    // #691 — Reject unknown versions instead of silently defaulting to v1.
    if (!isSupportedVersion(version)) {
      throw new BadRequestException(
        `Unsupported API version: ${version}. Supported versions: ${SUPPORTED_API_VERSIONS.join(', ')}.`,
      );
    }

    const apiVersion = apiVersionHeaderValue(version)!;

    // #713 — Emit the version headers up-front rather than in `tap`. `tap` only
    // runs once the handler emits, which is too late for streamed responses
    // (SSE/NDJSON) whose headers are flushed before the body completes.
    applyApiVersionHeaders(response, version);

    return next.handle().pipe(
      tap((data) => {
        if (data && data.success !== undefined) {
          data.metadata = data.metadata || {};
          data.metadata.version = apiVersion;
        }
      }),
    );
  }
}
