import { validate } from 'class-validator';
import { ConfirmPolicyDto } from './confirm-policy.dto';

const VALID_XDR =
  'AAAAAgAAAACAGSzBPCxGRnuILDyZUUdQcaqeU1MD9IfaptE/vDuunQAAAGQAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAD0hlcAAAAAAAAAAAEAAAAAAAAACwAAAAAAAAACAAAAAAAAAAG8O66dAAAAQKsBUgVQ/bT36y2LHtnkA1i9de6DiGsvJnDx08nQ2Cp+Ic+9c++M7mtRarRCRjxBh0Y1E4FnntWcSm6J2bWEFQM=';

function makeDto(signedXdr: string): ConfirmPolicyDto {
  const dto = new ConfirmPolicyDto();
  dto.signedXdr = signedXdr;
  dto.productId = '1';
  dto.coverageXlm = 500;
  dto.walletAddress = 'GMRFVCGKW6CSIEQIIIFFDKPQUXVBRNDFYKIPIOBAQPYXAL5QEGX2652T';
  dto.duration = 90;
  dto.oracleKey = 'rainfall:-0.0917,34.7679:2026-06';
  return dto;
}

describe('IsValidStellarXdr', () => {
  it('accepts a well-formed base64 XDR transaction envelope', async () => {
    const errors = await validate(makeDto(VALID_XDR));
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-base64 garbage string', async () => {
    const errors = await validate(makeDto('not-a-valid-xdr-string'));
    expect(errors.some((e) => e.property === 'signedXdr')).toBe(true);
  });

  it('rejects a valid-base64 string that is not an XDR envelope', async () => {
    const errors = await validate(
      makeDto(Buffer.from('just some random bytes, not xdr').toString('base64')),
    );
    expect(errors.some((e) => e.property === 'signedXdr')).toBe(true);
  });

  it('rejects the literal Swagger example placeholder', async () => {
    const errors = await validate(makeDto('AAAAAgAAAAA...'));
    expect(errors.some((e) => e.property === 'signedXdr')).toBe(true);
  });

  it('defers to @IsNotEmpty for an empty string', async () => {
    const errors = await validate(makeDto(''));
    const signedXdrErrors = errors.filter((e) => e.property === 'signedXdr');
    expect(signedXdrErrors).toHaveLength(1);
    expect(signedXdrErrors[0].constraints).not.toHaveProperty('isValidStellarXdr');
  });
});
