import { BadRequestException } from '@nestjs/common';
import { ClaimsService } from './claims.service';

jest.mock('../oracle/oracle.service', () => ({ OracleService: class OracleService {} }));

describe('ClaimsService evidence upload', () => {
  const claim = { id: 'claim-1', claimant: 'wallet-1' };
  const prisma = {
    claim: { findUnique: jest.fn().mockResolvedValue(claim) },
    claimEvidence: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const service = new ClaimsService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    prisma as any,
    {} as any,
    {} as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.claim.findUnique.mockResolvedValue(claim);
  });

  it('rejects an empty upload with a clear validation error', async () => {
    await expect(service.uploadEvidence('claim-1', 'wallet-1', [])).rejects.toThrow(
      new BadRequestException('At least one evidence file is required'),
    );

    expect(prisma.claim.findUnique).not.toHaveBeenCalled();
    expect(prisma.claimEvidence.createMany).not.toHaveBeenCalled();
  });

  it('validates and persists uploaded evidence for the claim owner', async () => {
    const buffer = Buffer.from('%PDF-1.7 evidence');

    await expect(service.uploadEvidence('claim-1', 'wallet-1', [{
      originalname: 'receipt.pdf',
      mimetype: 'application/pdf',
      buffer,
    }])).resolves.toEqual([{ filename: 'receipt.pdf', mimeType: 'application/pdf', size: buffer.length }]);

    expect(prisma.claimEvidence.createMany).toHaveBeenCalledWith({
      data: [{
        claimId: 'claim-1',
        filename: 'receipt.pdf',
        mimeType: 'application/pdf',
        size: buffer.length,
        content: buffer,
      }],
    });
  });
});