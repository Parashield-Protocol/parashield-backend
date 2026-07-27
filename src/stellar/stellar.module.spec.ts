import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StellarModule } from './stellar.module';
import { StellarService } from './stellar.service';

describe('StellarModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        StellarModule,
      ],
    })
      .overrideProvider(StellarService)
      .useValue({})
      .compile();
  });

  it('compiles successfully', () => {
    expect(module).toBeDefined();
  });

  it('provides StellarService', () => {
    expect(module.get(StellarService)).toBeDefined();
  });

  it('exports StellarService for other modules', () => {
    const exportedServices = Reflect.getMetadata('exports', StellarModule) ?? [];
    expect(exportedServices).toContain(StellarService);
  });
});
