import { AviationStackApiKeyGuard } from './aviation-stack-api-key.guard';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';

describe('AviationStackApiKeyGuard', () => {
  let guard: AviationStackApiKeyGuard;
  let mockConfigService: jest.Mocked<Pick<ConfigService, 'get'>>;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn(),
    };
    guard = new AviationStackApiKeyGuard(mockConfigService as any);
  });

  it('should allow activation if API key is set', () => {
    mockConfigService.get.mockReturnValue('valid-api-key');
    const mockContext = {} as ExecutionContext;
    expect(guard.canActivate(mockContext)).toBe(true);
  });

  it('should throw ServiceUnavailableException if API key is missing', () => {
    mockConfigService.get.mockReturnValue(undefined);
    const mockContext = {} as ExecutionContext;
    expect(() => guard.canActivate(mockContext)).toThrow(ServiceUnavailableException);
  });
});
