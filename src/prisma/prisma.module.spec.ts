import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';

describe('PrismaModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
  });

  it('compiles with its declared imports', () => {
    expect(module).toBeDefined();
  });

  it('provides PrismaService', () => {
    expect(module.get(PrismaService)).toBeDefined();
  });

  it('exports PrismaService', () => {
    const exports = Reflect.getMetadata('exports', PrismaModule);
    expect(exports).toContain(PrismaService);
  });
});
