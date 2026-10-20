import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { ConfigService } from '@nestjs/config';
import { StatusEventsService, PolicyOracleKeyChangeEvent } from '../common/events/status-events.service';
import { WebhooksService } from '../common/events/webhooks.service';
import { PolicyStatus } from '@prisma/client';

describe('Policy Oracle Key Change Event (#717)', () => {
  let service: PolicyService;

  const mockPrismaService = {
    policy: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };

  const mockStatusEventsService = {
    emitPolicyOracleKeyChange: jest.fn(),
  };

  const mockWebhooksService = {
    notifyPolicyOracleKeyChange: jest.fn().mockResolvedValue([]),
  };

  const mockStellarService = {};
  const mockConfigService = {
    get: jest.fn(),
  };

  const cropProduct = {
    id: 'prod-crop-1',
    name: 'Crop Insurance',
    category: 'crop',
    triggerType: 'rainfall',
    threshold: { toString: () => '50.0000000' },
    comparison: 'LessThan',
    coverageMin: { toString: () => '100.0000000' },
    coverageMax: { toString: () => '10000.0000000' },
    premiumRate: 500,
    maxDuration: 180,
    status: 'ACTIVE',
  };

  const initialPolicy = {
    id: 'policy-uuid-1',
    productId: 'prod-crop-1',
    policyholder: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
    coverageXlm: { toString: () => '1000.0000000' },
    premiumPaid: { toString: () => '50.0000000' },
    oracleKey: 'rainfall:-0.0917,34.7679:2026-06',
    startTime: new Date('2026-06-01T00:00:00Z'),
    endTime: new Date('2026-06-30T23:59:59Z'),
    status: PolicyStatus.ACTIVE,
    product: cropProduct,
    _count: { claims: 0 },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: StellarService, useValue: mockStellarService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: StatusEventsService, useValue: mockStatusEventsService },
        { provide: WebhooksService, useValue: mockWebhooksService },
      ],
    }).compile();

    service = module.get<PolicyService>(PolicyService);
  });

  it('changing the key emits exactly one event with old and new values, actor, timestamp, and correlationId', async () => {
    mockPrismaService.policy.findUnique.mockResolvedValue(initialPolicy);

    const newKey = 'rainfall:-0.0917,34.7679:2026-06'; // same month, but let's change coordinate or valid key
    const validNewKey = 'rainfall:-0.0920,34.7680:2026-06';

    const updatedPolicyRecord = {
      ...initialPolicy,
      oracleKey: validNewKey,
    };
    mockPrismaService.policy.update.mockResolvedValue(updatedPolicyRecord);

    const actor = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
    const correlationId = 'req-corr-12345';

    const result = await service.updatePolicy(
      initialPolicy.id,
      { oracleKey: validNewKey },
      actor,
      correlationId,
    );

    expect(result.oracleKey).toBe(validNewKey);
    expect(mockPrismaService.policy.update).toHaveBeenCalledWith({
      where: { id: initialPolicy.id },
      data: { oracleKey: validNewKey },
      include: { _count: { select: { claims: true } } },
    });

    // Emits exactly one event
    expect(mockStatusEventsService.emitPolicyOracleKeyChange).toHaveBeenCalledTimes(1);
    expect(mockWebhooksService.notifyPolicyOracleKeyChange).toHaveBeenCalledTimes(1);

    const emittedEvent: PolicyOracleKeyChangeEvent =
      mockStatusEventsService.emitPolicyOracleKeyChange.mock.calls[0][0];

    // Verify payload shape matches documentation
    expect(emittedEvent).toEqual({
      policyId: initialPolicy.id,
      oldOracleKey: 'rainfall:-0.0917,34.7679:2026-06',
      newOracleKey: validNewKey,
      actor,
      timestamp: expect.any(Number),
      correlationId,
    });
  });

  it('an update that does not change the key (no-op) emits nothing', async () => {
    mockPrismaService.policy.findUnique.mockResolvedValue(initialPolicy);

    // Same oracle key as current
    await service.updatePolicy(initialPolicy.id, {
      oracleKey: initialPolicy.oracleKey,
    });

    expect(mockPrismaService.policy.update).not.toHaveBeenCalled();
    expect(mockStatusEventsService.emitPolicyOracleKeyChange).not.toHaveBeenCalled();
    expect(mockWebhooksService.notifyPolicyOracleKeyChange).not.toHaveBeenCalled();
  });

  it('an update with absent oracleKey field emits nothing', async () => {
    mockPrismaService.policy.findUnique.mockResolvedValue(initialPolicy);

    await service.updatePolicy(initialPolicy.id, {});

    expect(mockPrismaService.policy.update).not.toHaveBeenCalled();
    expect(mockStatusEventsService.emitPolicyOracleKeyChange).not.toHaveBeenCalled();
    expect(mockWebhooksService.notifyPolicyOracleKeyChange).not.toHaveBeenCalled();
  });

  it('a failed or rolled-back database update emits nothing', async () => {
    mockPrismaService.policy.findUnique.mockResolvedValue(initialPolicy);
    const validNewKey = 'rainfall:-0.0920,34.7680:2026-06';

    // Simulate database update failure (e.g. database error / roll back)
    mockPrismaService.policy.update.mockRejectedValue(new Error('Database transaction rolled back'));

    await expect(
      service.updatePolicy(initialPolicy.id, { oracleKey: validNewKey }),
    ).rejects.toThrow('Database transaction rolled back');

    // MUST NOT emit any event when DB update fails
    expect(mockStatusEventsService.emitPolicyOracleKeyChange).not.toHaveBeenCalled();
    expect(mockWebhooksService.notifyPolicyOracleKeyChange).not.toHaveBeenCalled();
  });

  it('rejects invalid oracleKey format before any database write or event emission', async () => {
    mockPrismaService.policy.findUnique.mockResolvedValue(initialPolicy);

    await expect(
      service.updatePolicy(initialPolicy.id, { oracleKey: 'invalid-malformed-key' }),
    ).rejects.toThrow(BadRequestException);

    expect(mockPrismaService.policy.update).not.toHaveBeenCalled();
    expect(mockStatusEventsService.emitPolicyOracleKeyChange).not.toHaveBeenCalled();
  });

  it('rejects an endTime that is not after the effective startTime', async () => {
    mockPrismaService.policy.findUnique.mockResolvedValue(initialPolicy);

    await expect(
      service.updatePolicy(initialPolicy.id, {
        endTime: Math.floor(initialPolicy.startTime.getTime() / 1000),
      }),
    ).rejects.toThrow('endTime must be after startTime');

    expect(mockPrismaService.policy.update).not.toHaveBeenCalled();
  });

  it('persists a valid partial date update and validates oracle period coverage', async () => {
    mockPrismaService.policy.findUnique.mockResolvedValue(initialPolicy);
    mockPrismaService.policy.update.mockResolvedValue({
      ...initialPolicy,
      startTime: new Date('2026-06-05T00:00:00Z'),
    });

    await service.updatePolicy(initialPolicy.id, {
      startTime: Math.floor(new Date('2026-06-05T00:00:00Z').getTime() / 1000),
    });

    expect(mockPrismaService.policy.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: initialPolicy.id },
      data: { startTime: new Date('2026-06-05T00:00:00Z') },
    }));
  });

  it('throws NotFoundException for non-existent policy', async () => {
    mockPrismaService.policy.findUnique.mockResolvedValue(null);

    await expect(
      service.updatePolicy('non-existent-id', { oracleKey: 'rainfall:-0.0917,34.7679:2026-06' }),
    ).rejects.toThrow(NotFoundException);

    expect(mockPrismaService.policy.update).not.toHaveBeenCalled();
    expect(mockStatusEventsService.emitPolicyOracleKeyChange).not.toHaveBeenCalled();
  });
});
