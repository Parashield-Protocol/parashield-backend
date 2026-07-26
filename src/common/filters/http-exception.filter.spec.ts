import { HttpException, HttpStatus } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let logger: { error: jest.Mock; warn: jest.Mock };
  let json: jest.Mock;
  let res: { status: jest.Mock; json: jest.Mock };

  function mockHost(method: string, url: string) {
    json = jest.fn();
    res = { status: jest.fn().mockReturnValue({ json }), json };
    return {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ method, url }),
      }),
    } as any;
  }

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    logger = { error: jest.fn(), warn: jest.fn() };
    (filter as any).logger = logger;
  });

  it('responds with HttpException status and message for HttpException errors', () => {
    const host = mockHost('GET', '/resource');
    const error = new HttpException('Not found', HttpStatus.NOT_FOUND);

    filter.catch(error, host);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      statusCode: 404,
      message: 'Not found',
      path: '/resource',
      timestamp: expect.any(String),
    });
    expect(logger.warn).toHaveBeenCalledWith('GET /resource → 404');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('responds with 500 and generic message for non-HttpException errors', () => {
    const host = mockHost('POST', '/api/data');
    const error = new Error('database connection lost');

    filter.catch(error, host);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
      path: '/api/data',
      timestamp: expect.any(String),
    });
  });

  it('does not leak stack trace in the JSON response for non-HttpException errors', () => {
    const host = mockHost('DELETE', '/secret');
    const error = new Error('sensitive details');

    filter.catch(error, host);

    const responseBody = json.mock.calls[0][0];
    expect(responseBody).not.toHaveProperty('stack');
    expect(responseBody).not.toHaveProperty('trace');
    expect(responseBody).not.toHaveProperty('error');
    expect(responseBody.message).toBe('Internal server error');
  });

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
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
      path: '/crash',
      timestamp: expect.any(String),
    });
    expect(logger.error).toHaveBeenCalledWith(
      'GET /crash → 500',
      'string error',
    );
  });

  it('handles null exceptions without crashing', () => {
    const host = mockHost('GET', '/null');

    filter.catch(null, host);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
      path: '/null',
      timestamp: expect.any(String),
    });
  });

  it('includes statusCode, message, path, and timestamp in the response body', () => {
    const host = mockHost('PATCH', '/item');
    const error = new HttpException('Conflict', HttpStatus.CONFLICT);

    filter.catch(error, host);

    const body = json.mock.calls[0][0];
    expect(body).toEqual({
      statusCode: 409,
      message: 'Conflict',
      path: '/item',
      timestamp: expect.any(String),
    });
    expect(typeof body.timestamp).toBe('string');
  });
});
