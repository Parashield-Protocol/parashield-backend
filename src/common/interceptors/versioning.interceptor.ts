import { Injectable, NestInterceptor, ExecutionContext, CallHandler, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

const API_VERSIONS: Record<string, string> = {
  v1: '1.0.0',
  v2: '2.0.0',
};

const SUPPORTED_VERSIONS = Object.keys(API_VERSIONS);

@Injectable()
export class VersioningInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const path = request.path;
    const versionMatch = path.match(/^\/api\/(v\d+)/);
    const version = versionMatch ? versionMatch[1] : 'v1';

    // #691 — Reject unknown versions instead of silently defaulting to v1.
    if (!API_VERSIONS[version]) {
      throw new BadRequestException(
        `Unsupported API version: ${version}. Supported versions: ${SUPPORTED_VERSIONS.join(', ')}.`
      );
    }

    const apiVersion = API_VERSIONS[version];

    return next.handle().pipe(
      tap((data) => {
        response.setHeader('X-API-Version', apiVersion);

        if (version === 'v1') {
          response.setHeader('Deprecation', 'true');
          response.setHeader('Link', '</api/v2>; rel="successor"');
        }

        if (data && data.success !== undefined) {
          data.metadata = data.metadata || {};
          data.metadata.version = apiVersion;
        }
      }),
    );
  }
}