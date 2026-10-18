import { HttpException, HttpStatus, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GlobalExceptionFilter } from './http-exception.filter';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let logger: { error: jest.Mock; warn: jest.Mock };
  let json: jest.Mock;
  let setHeader: jest.Mock;
  let res: { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock };

  function mockHost(method: string, url: string, headers: Record<string, string> = {}) {
    json = jest.fn();
    setHeader = jest.fn();
    res = {
      status: jest.fn().mockReturnValue({ json }),
      json,
      setHeader,
    };
    return {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ method, url, headers }),
      }),
    } as any;
  }

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    logger = { error: jest.fn(), warn: jest.fn() };
    (filter as any).logger = logger;
  });

  describe('RFC 7807 Problem Details (#677)', () => {
    it('validation error (400) returns application/problem+json with type, title, status, detail, instance, errors array, and legacy fields', () => {
      const host = mockHost('POST', '/api/v1/policies/buy');
      const validationError = new BadRequestException({
        statusCode: 400,
        message: ['wallet must be a string', 'productId should not be empty'],
        error: 'Bad Request',
      });

      filter.catch(validationError, host);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/problem+json');
      expect(res.status).toHaveBeenCalledWith(400);

      const body = json.mock.calls[0][0];
      expect(body.type).toBe('https://parashield.io/errors/validation-error');
      expect(body.title).toBe('Bad Request');
      expect(body.status).toBe(400);
      expect(body.detail).toBe('wallet must be a string; productId should not be empty');
      expect(body.instance).toBe('/api/v1/policies/buy');
      expect(body.errors).toEqual(['wallet must be a string', 'productId should not be empty']);

      // Backward compatibility fields (deprecated)
      expect(body.success).toBe(false);
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe('wallet must be a string; productId should not be empty');
      expect(body.message).toBe('wallet must be a string; productId should not be empty');
      expect(body.path).toBe('/api/v1/policies/buy');
      expect(typeof body.timestamp).toBe('string');
    });

    it('401 Unauthorized returns application/problem+json with RFC 7807 members and legacy fields', () => {
      const host = mockHost('GET', '/api/v1/policies/me');
      const error = new UnauthorizedException('Missing or invalid authentication');

      filter.catch(error, host);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/problem+json');
      expect(res.status).toHaveBeenCalledWith(401);

      const body = json.mock.calls[0][0];
      expect(body.type).toBe('https://parashield.io/errors/unauthorized');
      expect(body.title).toBe('Unauthorized');
      expect(body.status).toBe(401);
      expect(body.detail).toBe('Missing or invalid authentication');
      expect(body.instance).toBe('/api/v1/policies/me');

      expect(body.success).toBe(false);
      expect(body.statusCode).toBe(401);
      expect(body.error).toBe('Missing or invalid authentication');
      expect(body.message).toBe('Missing or invalid authentication');
      expect(body.errorCode).toBe('UNAUTHORIZED');
      expect(body.path).toBe('/api/v1/policies/me');
    });

    it('404 Not Found returns application/problem+json with RFC 7807 members and legacy fields', () => {
      const host = mockHost('GET', '/api/v1/policies/missing-uuid');
      const error = new HttpException('Policy not found', HttpStatus.NOT_FOUND);

      filter.catch(error, host);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/problem+json');
      expect(res.status).toHaveBeenCalledWith(404);

      const body = json.mock.calls[0][0];
      expect(body.type).toBe('https://parashield.io/errors/not-found');
      expect(body.title).toBe('Not Found');
      expect(body.status).toBe(404);
      expect(body.detail).toBe('Policy not found');
      expect(body.instance).toBe('/api/v1/policies/missing-uuid');

      expect(body.success).toBe(false);
      expect(body.statusCode).toBe(404);
      expect(body.error).toBe('Policy not found');
      expect(body.message).toBe('Policy not found');
      expect(body.errorCode).toBe('NOT_FOUND');
    });

    it('unexpected 500 returns generic message, application/problem+json, and never leaks internal details', () => {
      const host = mockHost('POST', '/api/v1/claims/submit');
      const internalError = new Error('SELECT * FROM users WHERE password = secret; FATAL: connection reset');
      (internalError as any).stack = 'Error: SELECT ... at /app/node_modules/pg/...';

      filter.catch(internalError, host);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/problem+json');
      expect(res.status).toHaveBeenCalledWith(500);

      const body = json.mock.calls[0][0];
      expect(body.type).toBe('https://parashield.io/errors/internal-error');
      expect(body.title).toBe('Internal Server Error');
      expect(body.status).toBe(500);
      expect(body.detail).toBe('An unexpected error occurred. Please try again later.');

      expect(body).not.toHaveProperty('stack');
      expect(body).not.toHaveProperty('trace');
      expect(JSON.stringify(body)).not.toContain('SELECT');
      expect(JSON.stringify(body)).not.toContain('FATAL');
      expect(JSON.stringify(body)).not.toContain('secret');

      expect(body.success).toBe(false);
      expect(body.statusCode).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(body.errorCode).toBe('INTERNAL_ERROR');
    });

    it('includes request correlationId when x-correlation-id header is provided', () => {
      const host = mockHost('GET', '/api/v1/policies', { 'x-correlation-id': 'req-corr-123' });
      const error = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

      filter.catch(error, host);

      const body = json.mock.calls[0][0];
      expect(body.correlationId).toBe('req-corr-123');
    });
  });

  describe('Prisma Error Mapping & Security Hardening (#688)', () => {
    it('P2002 unique constraint error maps to 409 Conflict with generic message and zero leaks', () => {
      const host = mockHost('POST', '/api/v1/policies/buy', { 'x-correlation-id': 'corr-p2002' });
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`policyholder`, `productId`, `oracleKey`) in table `Policy`',
        {
          code: 'P2002',
          clientVersion: '6.0.0',
          meta: {
            target: ['policyholder', 'productId', 'oracleKey'],
            modelName: 'Policy',
            database_url: 'postgresql://postgres:secret123@localhost:5432/parashield',
          },
        },
      );

      filter.catch(p2002Error, host);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = json.mock.calls[0][0];

      // Safe RFC 7807 problem details
      expect(body.status).toBe(409);
      expect(body.errorCode).toBe('CONFLICT');
      expect(body.detail).toBe('A resource with conflicting unique attributes already exists.');
      expect(body.correlationId).toBe('corr-p2002');

      // Crucial: assert that NO Prisma codes, table/column names, meta, connection string, or internal details leak
      const bodyString = JSON.stringify(body);
      expect(bodyString).not.toContain('P2002');
      expect(bodyString).not.toContain('policyholder');
      expect(bodyString).not.toContain('productId');
      expect(bodyString).not.toContain('oracleKey');
      expect(bodyString).not.toContain('Policy');
      expect(bodyString).not.toContain('Unique constraint');
      expect(bodyString).not.toContain('secret123');
      expect(bodyString).not.toContain('postgresql://');
      expect(body).not.toHaveProperty('meta');
      expect(body).not.toHaveProperty('clientVersion');
      expect(body).not.toHaveProperty('stack');

      // Logged once with warn level and correlation ID
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn.mock.calls[0][0]).toContain('[Prisma PrismaClientKnownRequestError (P2002)]');
      expect(logger.warn.mock.calls[0][0]).toContain('POST /api/v1/policies/buy → 409 [corr: corr-p2002]');
      // Assert connection string in meta was scrubbed in logs
      expect(logger.warn.mock.calls[0][0]).not.toContain('secret123');
    });

    it('P2003 foreign key constraint error maps to 409 Conflict with generic message', () => {
      const host = mockHost('POST', '/api/v1/claims/submit');
      const p2003Error = new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed on the field: `productId` on table `Product`',
        { code: 'P2003', clientVersion: '6.0.0', meta: { field_name: 'productId' } },
      );

      filter.catch(p2003Error, host);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(409);
      expect(body.errorCode).toBe('CONFLICT');
      expect(body.detail).toBe('The requested operation violates an existing relationship constraint.');

      const bodyString = JSON.stringify(body);
      expect(bodyString).not.toContain('P2003');
      expect(bodyString).not.toContain('productId');
      expect(bodyString).not.toContain('Product');
      expect(bodyString).not.toContain('Foreign key');
    });

    it('P2014 relation violation maps to 409 Conflict with generic message', () => {
      const host = mockHost('DELETE', '/api/v1/products/123');
      const p2014Error = new Prisma.PrismaClientKnownRequestError(
        'The change you are trying to make would violate the required relation `PolicyToProduct`',
        { code: 'P2014', clientVersion: '6.0.0' },
      );

      filter.catch(p2014Error, host);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(409);
      expect(body.errorCode).toBe('CONFLICT');
      expect(body.detail).toBe('The requested operation violates a model relation constraint.');
      expect(JSON.stringify(body)).not.toContain('PolicyToProduct');
      expect(JSON.stringify(body)).not.toContain('P2014');
    });

    it('P2034 transaction serialization/write conflict maps to 409 Conflict with retry message', () => {
      const host = mockHost('POST', '/api/v1/claims/submit');
      const p2034Error = new Prisma.PrismaClientKnownRequestError(
        'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
        { code: 'P2034', clientVersion: '6.0.0' },
      );

      filter.catch(p2034Error, host);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(409);
      expect(body.errorCode).toBe('CONFLICT');
      expect(body.detail).toBe('A concurrent modification conflict occurred. Please retry your request.');
      expect(JSON.stringify(body)).not.toContain('P2034');
    });

    it('P2025 record not found maps to 404 Not Found with generic message', () => {
      const host = mockHost('GET', '/api/v1/policies/unknown-id');
      const p2025Error = new Prisma.PrismaClientKnownRequestError(
        'An operation failed because it depends on one or more records that were required but not found. Expected a record in table `Policy` with id `unknown-id`',
        { code: 'P2025', clientVersion: '6.0.0' },
      );

      filter.catch(p2025Error, host);

      expect(res.status).toHaveBeenCalledWith(404);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(404);
      expect(body.errorCode).toBe('NOT_FOUND');
      expect(body.detail).toBe('The requested resource was not found.');

      const bodyString = JSON.stringify(body);
      expect(bodyString).not.toContain('P2025');
      expect(bodyString).not.toContain('Policy');
      expect(bodyString).not.toContain('unknown-id');
    });

    it('P2015 and P2018 related records not found map to 404 Not Found', () => {
      const host = mockHost('GET', '/api/v1/policies/123/product');
      const p2015Error = new Prisma.PrismaClientKnownRequestError('A related record could not be found', {
        code: 'P2015',
        clientVersion: '6.0.0',
      });

      filter.catch(p2015Error, host);

      expect(res.status).toHaveBeenCalledWith(404);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(404);
      expect(body.errorCode).toBe('NOT_FOUND');
      expect(body.detail).toBe('The requested resource was not found.');
      expect(JSON.stringify(body)).not.toContain('P2015');
    });

    it('P2000 value too long maps to 400 Bad Request with generic message', () => {
      const host = mockHost('POST', '/api/v1/oracle/data');
      const p2000Error = new Prisma.PrismaClientKnownRequestError(
        'The provided value for the column `oracleKey` is too long for the column type: varchar(255)',
        { code: 'P2000', clientVersion: '6.0.0' },
      );

      filter.catch(p2000Error, host);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(400);
      expect(body.errorCode).toBe('BAD_REQUEST');
      expect(body.detail).toBe('The provided value exceeds the maximum allowed length.');
      expect(JSON.stringify(body)).not.toContain('oracleKey');
      expect(JSON.stringify(body)).not.toContain('P2000');
    });

    it('P2011 null constraint violation maps to 400 Bad Request with generic message', () => {
      const host = mockHost('POST', '/api/v1/policies');
      const p2011Error = new Prisma.PrismaClientKnownRequestError(
        'Null constraint violation on the column `coverageXlm`',
        { code: 'P2011', clientVersion: '6.0.0' },
      );

      filter.catch(p2011Error, host);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(400);
      expect(body.errorCode).toBe('BAD_REQUEST');
      expect(body.detail).toBe('A required field was missing or null.');
      expect(JSON.stringify(body)).not.toContain('coverageXlm');
      expect(JSON.stringify(body)).not.toContain('P2011');
    });

    it('P2024 connection pool timeout maps to 503 Service Unavailable with generic message', () => {
      const host = mockHost('GET', '/api/v1/policies');
      const p2024Error = new Prisma.PrismaClientKnownRequestError(
        'Timed out fetching a new connection from the connection pool (more info: http://pris.ly/d/connection-pool)',
        { code: 'P2024', clientVersion: '6.0.0' },
      );

      filter.catch(p2024Error, host);

      expect(res.status).toHaveBeenCalledWith(503);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(503);
      expect(body.errorCode).toBe('SERVICE_UNAVAILABLE');
      expect(body.detail).toBe('Database service is temporarily unavailable. Please try again later.');
      expect(JSON.stringify(body)).not.toContain('P2024');
      expect(JSON.stringify(body)).not.toContain('connection pool');

      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('unmapped Prisma code (P2021 table does not exist) falls back to 500 with generic message and no leaks', () => {
      const host = mockHost('GET', '/api/v1/data');
      const p2021Error = new Prisma.PrismaClientKnownRequestError(
        'The table `public.SecretInternalTable` does not exist in the current database.',
        { code: 'P2021', clientVersion: '6.0.0' },
      );

      filter.catch(p2021Error, host);

      expect(res.status).toHaveBeenCalledWith(500);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(500);
      expect(body.errorCode).toBe('INTERNAL_ERROR');
      expect(body.detail).toBe('An unexpected database error occurred. Please try again later.');

      const bodyString = JSON.stringify(body);
      expect(bodyString).not.toContain('P2021');
      expect(bodyString).not.toContain('SecretInternalTable');
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('PrismaClientValidationError maps to 400 Bad Request with generic message', () => {
      const host = mockHost('POST', '/api/v1/policies');
      const validationError = new Prisma.PrismaClientValidationError(
        'Invalid `prisma.policy.create()` invocation:\nUnknown argument `extraField`. Did you mean `productId`?',
        { clientVersion: '6.0.0' },
      );

      filter.catch(validationError, host);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(400);
      expect(body.errorCode).toBe('BAD_REQUEST');
      expect(body.detail).toBe('Invalid data provided for database operation.');

      const bodyString = JSON.stringify(body);
      expect(bodyString).not.toContain('extraField');
      expect(bodyString).not.toContain('productId');
      expect(bodyString).not.toContain('prisma.policy.create');
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('PrismaClientInitializationError maps to 503 Service Unavailable with generic message', () => {
      const host = mockHost('GET', '/api/v1/health');
      const initError = new Prisma.PrismaClientInitializationError(
        'Can\'t reach database server at `db.internal.production.net:5432` with username `pg_admin`',
        '6.0.0',
        'P1001',
      );

      filter.catch(initError, host);

      expect(res.status).toHaveBeenCalledWith(503);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(503);
      expect(body.errorCode).toBe('SERVICE_UNAVAILABLE');
      expect(body.detail).toBe('Database service is temporarily unavailable. Please try again later.');

      const bodyString = JSON.stringify(body);
      expect(bodyString).not.toContain('db.internal.production.net');
      expect(bodyString).not.toContain('pg_admin');
      expect(bodyString).not.toContain('P1001');
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('PrismaClientUnknownRequestError maps to 500 Internal Server Error with generic message', () => {
      const host = mockHost('GET', '/api/v1/policies');
      const unknownError = new Prisma.PrismaClientUnknownRequestError(
        'Unknown database engine response error occurred',
        { clientVersion: '6.0.0' },
      );

      filter.catch(unknownError, host);

      expect(res.status).toHaveBeenCalledWith(500);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(500);
      expect(body.errorCode).toBe('INTERNAL_ERROR');
      expect(body.detail).toBe('An unexpected database error occurred. Please try again later.');
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('PrismaClientRustPanicError maps to 500 Internal Server Error with generic message', () => {
      const host = mockHost('GET', '/api/v1/policies');
      const panicError = new Prisma.PrismaClientRustPanicError(
        'Engine crashed with panic at query-engine/core/src/...',
        '6.0.0',
      );

      filter.catch(panicError, host);

      expect(res.status).toHaveBeenCalledWith(500);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(500);
      expect(body.errorCode).toBe('INTERNAL_ERROR');
      expect(body.detail).toBe('An unexpected database error occurred. Please try again later.');
      expect(JSON.stringify(body)).not.toContain('panic');
      expect(JSON.stringify(body)).not.toContain('query-engine');
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('handles Prisma error wrapped as the cause of an HttpException', () => {
      const host = mockHost('POST', '/api/v1/policies/buy');
      const innerPrisma = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`txHash`)',
        { code: 'P2002', clientVersion: '6.0.0' },
      );
      const wrappedError = new BadRequestException('Transaction creation failed', { cause: innerPrisma });

      filter.catch(wrappedError, host);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(409);
      expect(body.errorCode).toBe('CONFLICT');
      expect(body.detail).toBe('A resource with conflicting unique attributes already exists.');
      expect(JSON.stringify(body)).not.toContain('txHash');
      expect(JSON.stringify(body)).not.toContain('P2002');
    });

    it('handles Prisma error wrapped as the cause of a standard Error', () => {
      const host = mockHost('POST', '/api/v1/policies');
      const innerPrisma = new Prisma.PrismaClientKnownRequestError(
        'Record not found',
        { code: 'P2025', clientVersion: '6.0.0' },
      );
      const wrappedError = new Error('Service error');
      (wrappedError as any).cause = innerPrisma;

      filter.catch(wrappedError, host);

      expect(res.status).toHaveBeenCalledWith(404);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(404);
      expect(body.errorCode).toBe('NOT_FOUND');
      expect(body.detail).toBe('The requested resource was not found.');
    });

    it('handles duck-typed Prisma error across module boundaries (fallback on P-code pattern)', () => {
      const host = mockHost('POST', '/api/v1/policies');
      // Simulated plain object / different bundle instance
      const duckTypedError = {
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
        message: 'Unique constraint failed on (email)',
        meta: { target: ['email'] },
      };

      filter.catch(duckTypedError, host);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(409);
      expect(body.errorCode).toBe('CONFLICT');
      expect(body.detail).toBe('A resource with conflicting unique attributes already exists.');
      expect(JSON.stringify(body)).not.toContain('email');
      expect(JSON.stringify(body)).not.toContain('P2002');
    });

    it('sanitizes HttpException that re-throws a raw Prisma message containing a P-code', () => {
      const host = mockHost('POST', '/api/v1/test');
      const rethrown = new BadRequestException('Raw Prisma error: P2002 on column secret_column');

      filter.catch(rethrown, host);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(409);
      expect(body.errorCode).toBe('CONFLICT');
      expect(body.detail).toBe('A resource with conflicting unique attributes already exists.');
      expect(JSON.stringify(body)).not.toContain('secret_column');
      expect(JSON.stringify(body)).not.toContain('P2002');
    });
  });

  describe('Logging and edge cases', () => {
    it('logs error level with stack trace for 5xx errors', () => {
      const host = mockHost('PUT', '/update');
      const error = new Error('timeout');
      (error as any).status = 500;

      filter.catch(error, host);

      expect(logger.error).toHaveBeenCalledWith(
        'PUT /update → 500',
        error.stack,
      );
    });

    it('logs warn level for 4xx client errors', () => {
      const host = mockHost('GET', '/not-found');
      const error = new HttpException('Bad request', HttpStatus.BAD_REQUEST);

      filter.catch(error, host);

      expect(logger.warn).toHaveBeenCalledWith('GET /not-found → 400');
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('handles string exceptions without crashing', () => {
      const host = mockHost('GET', '/crash');
      const error = 'string error';

      filter.catch(error, host);

      expect(res.status).toHaveBeenCalledWith(500);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(500);
      expect(body.detail).toBe('An unexpected error occurred. Please try again later.');
      expect(logger.error).toHaveBeenCalledWith(
        'GET /crash → 500',
        'string error',
      );
    });

    it('handles null exceptions without crashing', () => {
      const host = mockHost('GET', '/null');

      filter.catch(null, host);

      expect(res.status).toHaveBeenCalledWith(500);
      const body = json.mock.calls[0][0];
      expect(body.status).toBe(500);
      expect(body.detail).toBe('An unexpected error occurred. Please try again later.');
    });
  });
});
