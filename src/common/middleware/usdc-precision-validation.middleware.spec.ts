import { BadRequestException } from '@nestjs/common';
import { UsdcPrecisionValidationMiddleware } from './usdc-precision-validation.middleware';
import { Request, Response, NextFunction } from 'express';

describe('UsdcPrecisionValidationMiddleware', () => {
  let middleware: UsdcPrecisionValidationMiddleware;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    middleware = new UsdcPrecisionValidationMiddleware();
    mockRequest = {};
    mockResponse = {};
    mockNext = jest.fn();
  });

  it('should pass when request has no body', () => {
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should pass when body has no amount fields', () => {
    mockRequest.body = { name: 'Test', description: 'Test description' };
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should pass with valid 7 decimal precision', () => {
    mockRequest.body = { amount: '10.1234567' };
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should pass with less than 7 decimal places', () => {
    mockRequest.body = { amount: '10.12' };
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should pass with integer amounts', () => {
    mockRequest.body = { amount: '100' };
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should reject amounts with more than 7 decimal places', () => {
    mockRequest.body = { amount: '10.12345678' };
    expect(() => {
      middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    }).toThrow(BadRequestException);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should validate premium field', () => {
    mockRequest.body = { premium: '5.123456789' };
    expect(() => {
      middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    }).toThrow(BadRequestException);
  });

  it('should validate coverageAmount field', () => {
    mockRequest.body = { coverageAmount: '1000.12345678' };
    expect(() => {
      middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    }).toThrow(BadRequestException);
  });

  it('should validate nested objects', () => {
    mockRequest.body = {
      policy: {
        amount: '10.12345678',
      },
    };
    expect(() => {
      middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    }).toThrow(BadRequestException);
  });

  it('should validate arrays', () => {
    mockRequest.body = {
      payouts: [
        { amount: '10.1234567' },
        { amount: '20.12345678' },
      ],
    };
    expect(() => {
      middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    }).toThrow(BadRequestException);
  });

  it('should handle null and undefined amounts gracefully', () => {
    mockRequest.body = {
      amount: null,
      premium: undefined,
    };
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should reject invalid number formats', () => {
    mockRequest.body = { amount: 'not-a-number' };
    expect(() => {
      middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    }).toThrow(BadRequestException);
  });

  it('should handle case-insensitive field names', () => {
    mockRequest.body = { Amount: '10.12345678', PREMIUM: '5.123456789' };
    expect(() => {
      middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    }).toThrow(BadRequestException);
  });

  it('should validate multiple amount fields in the same object', () => {
    mockRequest.body = {
      amount: '10.1234567',
      premium: '5.1234567',
      coverageAmount: '1000.1234567',
    };
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should provide descriptive error messages', () => {
    mockRequest.body = { amount: '10.12345678' };
    try {
      middleware.use(mockRequest as Request, mockResponse as Response, mockNext);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toContain('Amount precision');
      expect((error as BadRequestException).message).toContain('Maximum 7 decimal places');
    }
  });
});
