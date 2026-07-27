import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth.module';
import { AuthController } from './auth.controller';
import { AuthMiddleware } from './auth.middleware';
import { JwtService } from './jwt.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OperatorAuthGuard } from './operator-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
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
});
