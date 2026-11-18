import { BadRequestException } from '@nestjs/common';
import { ClaimsService } from './claims.service';
import {
  MAX_EVIDENCE_FILE_SIZE,
  MAX_EVIDENCE_PER_CLAIM_SIZE,
  MAX_EVIDENCE_UPLOAD_SIZE,
} from './evidence-validation';

jest.mock('../oracle/oracle.service', () => ({ OracleService: class OracleService {} }));

describe('ClaimsService evidence upload', () => {
  const claim = { id: 'claim-1', claimant: 'wallet-1' };
  const prisma = {
    claim: { findUnique: jest.fn().mockResolvedValue(claim) },
    claimEvidence: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      aggregate: jest.fn().mockResolvedValue({ _sum: { size: 0 } }),
    },
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
    prisma.claimEvidence.aggregate.mockResolvedValue({ _sum: { size: 0 } });
  });

  // #813 — size limits are enforced in the service, not only by multer.
  const pdf = (bytes: number) =>
    Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(Math.max(0, bytes - 4))]);

  it('rejects a single file over MAX_EVIDENCE_FILE_SIZE before any DB access', async () => {
    await expect(service.uploadEvidence('claim-1', 'wallet-1', [{
      originalname: 'huge.pdf',
      mimetype: 'application/pdf',
      buffer: pdf(MAX_EVIDENCE_FILE_SIZE + 1),
    }])).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.claim.findUnique).not.toHaveBeenCalled();
    expect(prisma.claimEvidence.createMany).not.toHaveBeenCalled();
  });

  it('rejects an upload whose files together exceed MAX_EVIDENCE_UPLOAD_SIZE', async () => {
    const perFile = Math.floor(MAX_EVIDENCE_UPLOAD_SIZE / 3) + 1;
    const files = [1, 2, 3].map((i) => ({
      originalname: `part-${i}.pdf`,
      mimetype: 'application/pdf',
      buffer: pdf(perFile),
    }));

    await expect(service.uploadEvidence('claim-1', 'wallet-1', files)).rejects.toThrow(
      /in total/,
    );
    expect(prisma.claimEvidence.createMany).not.toHaveBeenCalled();
  });

  it('rejects an upload that would push the claim past MAX_EVIDENCE_PER_CLAIM_SIZE', async () => {
    prisma.claimEvidence.aggregate.mockResolvedValue({
      _sum: { size: MAX_EVIDENCE_PER_CLAIM_SIZE - 10 },
    });

    await expect(service.uploadEvidence('claim-1', 'wallet-1', [{
      originalname: 'receipt.pdf',
      mimetype: 'application/pdf',
      buffer: pdf(100),
    }])).rejects.toThrow(/may not exceed/);

    expect(prisma.claimEvidence.aggregate).toHaveBeenCalledWith({
      where: { claimId: 'claim-1' },
      _sum: { size: true },
    });
    expect(prisma.claimEvidence.createMany).not.toHaveBeenCalled();
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