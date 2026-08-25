import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

const API_VERSIONS = {
  v1: '1.0.0',
  v2: '2.0.0',
};

@Injectable()
export class VersioningInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const path = request.path;
    let version = 'v1';

    if (path.startsWith('/api/v2')) {
      version = 'v2';
    } else if (path.startsWith('/api/v1')) {
      version = 'v1';
    }

    const apiVersion = API_VERSIONS[version] || API_VERSIONS.v1;

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