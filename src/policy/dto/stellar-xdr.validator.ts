import { registerDecorator, ValidationOptions } from 'class-validator';
import { xdr } from '@stellar/stellar-sdk';

/**
 * Confirms `signedXdr` is at least a structurally valid Stellar transaction
 * envelope before it reaches policy.service.ts, which builds a Transaction
 * from it (source/timeBounds checks, contract submission, etc.). Without
 * this, a malformed XDR string passes DTO validation as a non-empty string
 * and only fails deep inside the service, as an unhandled SDK parse error
 * rather than a clean 400.
 *
 * This is a structural check only (base64 → TransactionEnvelope), not a
 * network-passphrase check — that distinction (wrong network vs malformed
 * envelope) is left to the service, which has the configured passphrase.
 */
export function IsValidStellarXdr(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidStellarXdr',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || value.length === 0) return true; // deferred to @IsString/@IsNotEmpty
          try {
            xdr.TransactionEnvelope.fromXDR(value, 'base64');
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage() {
          return 'signedXdr must be a valid base64-encoded Stellar transaction envelope';
        },
      },
    });
  };
}
