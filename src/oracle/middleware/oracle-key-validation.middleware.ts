import { Injectable, NestMiddleware, BadRequestException, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { isValidOracleKeyFormat, ORACLE_KEY_FORMAT_DESCRIPTION } from '../oracle-key-format';

/**
 * OracleKeyValidationMiddleware (#473)
 *
 * Rejects malformed oracle keys with 400 before they reach OracleController,
 * instead of the request falling through to OracleService and either doing a
 * pointless DB lookup that resolves as a plain 404 "not found" or — for
 * anything that isn't purely a read — silently producing a NO_DATA/garbage
 * reading built from an unrecognized key.
 *
 * Registered (see OracleModule.configure) on the two endpoints that accept a
 * raw oracle key from the caller: GET /oracle/reading?key= and
 * GET /oracle/latest/:key. Requests with no key present pass through
 * untouched — validation only applies once a key is actually supplied.
 */
@Injectable()
export class OracleKeyValidationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(OracleKeyValidationMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    const queryKey = req.query.key;
    const pathKey = req.params.key;

    // Mirrors OracleController#getReadingByKey, which explicitly
    // decodeURIComponent()s the query key on top of Express's own automatic
    // query-string decoding (clients are expected to double-encode it).
    // Path params get no such second decode, matching #getLatestReading.
    let key: string | undefined;
    if (typeof queryKey === 'string' && queryKey.length > 0) {
      key = decodeURIComponent(queryKey);
    } else if (typeof pathKey === 'string' && pathKey.length > 0) {
      key = pathKey;
    }

    if (!key) {
      return next();
    }

    if (!isValidOracleKeyFormat(key)) {
      this.logger.warn(`Rejected malformed oracle key: ${key}`);
      throw new BadRequestException(
        `Invalid oracle key format: "${key}". Expected ${ORACLE_KEY_FORMAT_DESCRIPTION}.`,
      );
    }

    next();
  }
}
