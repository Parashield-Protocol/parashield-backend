import { HttpException, HttpStatus, BadRequestException, UnauthorizedException } from '@nestjs/common';
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
      // RFC 7807 standard members
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

      // Backward compatibility fields
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

      // Backward compatibility fields
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

      // No stack traces, SQL, or internal details leak
      expect(body).not.toHaveProperty('stack');
      expect(body).not.toHaveProperty('trace');
      expect(JSON.stringify(body)).not.toContain('SELECT');
      expect(JSON.stringify(body)).not.toContain('FATAL');
      expect(JSON.stringify(body)).not.toContain('secret');

      // Backward compatibility fields
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
