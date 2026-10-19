/**
 * Cache-Control interceptor for sensitive API responses (#746).
 *
 * Sets `Cache-Control: no-store, private` on responses from sensitive
 * endpoints (auth, claims, policy details) to prevent intermediary
 * caching by proxies/CDNs. Sensitive financial and identity data must
 * never be cached.
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import type { Response } from "express";

@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  constructor(private readonly directives: string = "no-store, private, max-age=0") {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const res = ctx.getResponse<Response>();

    return next.handle().pipe(
      tap(() => {
        res.setHeader("Cache-Control", this.directives);
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }),
    );
  }
}

/**
 * Factory for the standard sensitive-response cache-control interceptor.
 */
export function sensitiveCacheControl(): CacheControlInterceptor {
  return new CacheControlInterceptor();
}
