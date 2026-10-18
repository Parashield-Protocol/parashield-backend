import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Global, Module } from '@nestjs/common';
import { AuthModule } from './auth.module';
import { AuthController } from './auth.controller';
import { AuthMiddleware } from './auth.middleware';
import { JwtService } from './jwt.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OperatorAuthGuard } from './operator-auth.guard';
import { AdminRoleGuard } from './admin-role.guard';
import { PrismaService } from '../prisma/prisma.service';


// RedisModule is @Global in the real app; this test module stands in for it
// so REDIS_CLIENT-dependent guards/workers resolve without a live Redis.
@Global()
@Module({
  providers: [{ provide: 'REDIS_CLIENT', useValue: {} }],
  exports: ['REDIS_CLIENT'],
})
class StubRedisModule {}

describe('AuthModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        StubRedisModule,
        AuthModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(JwtService)
      .useValue({})
      .compile();
  });

  it('compiles successfully', () => {
    expect(module).toBeDefined();
  });

  it('wires up AuthController', () => {
    expect(module.get(AuthController)).toBeInstanceOf(AuthController);
  });

  it('provides AuthMiddleware', () => {
    expect(module.get(AuthMiddleware)).toBeDefined();
  });

  it('provides JwtService', () => {
    expect(module.get(JwtService)).toBeDefined();
  });

  it('provides JwtAuthGuard', () => {
    expect(module.get(JwtAuthGuard)).toBeDefined();
  });

  it('provides OperatorAuthGuard', () => {
    expect(module.get(OperatorAuthGuard)).toBeDefined();
  });

  it('exports AuthMiddleware for use in other modules', () => {
    const exportedServices = Reflect.getMetadata('exports', AuthModule) ?? [];
    expect(exportedServices).toContain(AuthMiddleware);
  });

  it('exports JwtService for use in other modules', () => {
    const exportedServices = Reflect.getMetadata('exports', AuthModule) ?? [];
    expect(exportedServices).toContain(JwtService);
  });

  it('exports JwtAuthGuard for use in other modules', () => {
    const exportedServices = Reflect.getMetadata('exports', AuthModule) ?? [];
    expect(exportedServices).toContain(JwtAuthGuard);
  });

  it('exports OperatorAuthGuard for use in other modules', () => {
    const exportedServices = Reflect.getMetadata('exports', AuthModule) ?? [];
    expect(exportedServices).toContain(OperatorAuthGuard);
  });

  it('provides AdminRoleGuard', () => {
    expect(module.get(AdminRoleGuard)).toBeDefined();
  });

  it('exports AdminRoleGuard for use in other modules', () => {
    const exportedServices = Reflect.getMetadata('exports', AuthModule) ?? [];
    expect(exportedServices).toContain(AdminRoleGuard);
  });
});
