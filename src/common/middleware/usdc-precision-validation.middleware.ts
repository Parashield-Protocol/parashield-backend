import { Injectable, NestMiddleware, BadRequestException, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * #465 — USDC amount precision validation middleware.
 *
 * Stellar USDC uses 7 decimal places of precision. Amounts with greater
 * precision than this will cause contract errors when submitted to Soroban.
 * This middleware intercepts requests containing monetary amounts and validates
 * that they conform to the 7-decimal constraint before processing.
 *
 * Fields checked (case-insensitive):
 * - amount
 * - premium
 * - coverageAmount
 * - payoutAmount
 * - minPayout
 * - maxPayout
 *
 * The middleware recursively validates nested objects and arrays. Any field
 * name matching the above list (case-insensitive) is checked for precision.
 *
 * Invalid amounts result in a 400 Bad Request with a descriptive error message
 * identifying the field and explaining the precision constraint.
 */
@Injectable()
export class UsdcPrecisionValidationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UsdcPrecisionValidationMiddleware.name);
  private readonly MAX_DECIMAL_PLACES = 7;
  
  // Field names that should be validated for USDC precision
  private readonly AMOUNT_FIELDS = new Set([
    'amount',
    'premium',
    'coverageamount',
    'payoutamount',
    'minpayout',
    'maxpayout',
  ]);

  use(req: Request, res: Response, next: NextFunction) {
    if (!req.body || typeof req.body !== 'object') {
      return next();
    }

    try {
      this.validateObject(req.body, []);
      next();
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error(`USDC precision validation error: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadRequestException('Invalid amount precision');
    }
  }

  private validateObject(obj: any, path: string[]): void {
    if (obj === null || obj === undefined) return;

    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        this.validateObject(item, [...path, `[${index}]`]);
      });
      return;
    }

    if (typeof obj !== 'object') return;

    for (const [key, value] of Object.entries(obj)) {
      const currentPath = [...path, key];
      const normalizedKey = key.toLowerCase();

      if (this.AMOUNT_FIELDS.has(normalizedKey)) {
        this.validateAmount(value, currentPath);
      } else if (typeof value === 'object' && value !== null) {
        this.validateObject(value, currentPath);
      }
    }
  }

  private validateAmount(value: any, path: string[]): void {
    // Skip null/undefined
    if (value === null || value === undefined) return;

    // Convert to string for validation
    const strValue = String(value);
    
    // Skip empty strings
    if (strValue.trim() === '') return;

    // Validate it's a valid number format (integer or decimal, not scientific notation)
    if (!/^-?\d+(\.\d+)?$/.test(strValue)) {
      throw new BadRequestException(
        `Invalid amount format at ${path.join('.')}: "${strValue}". Must be a valid numeric value.`
      );
    }

    // Check decimal precision (#663) — reject values with > MAX_DECIMAL_PLACES
    const parts = strValue.split('.');
    if (parts.length === 2 && parts[1].length > this.MAX_DECIMAL_PLACES) {
      throw new BadRequestException(
        `Amount precision at ${path.join('.')} exceeds Stellar USDC limit. ` +
        `Maximum ${this.MAX_DECIMAL_PLACES} decimal places allowed, found ${parts[1].length}. ` +
        `Value: "${strValue}"`
      );
    }

    // #692 — Reject negative zero (-0) which can cause unexpected arithmetic.
    // -0 === 0 in JS but has different string representation and bit pattern.
    if (Object.is(value, -0) || strValue === '-0' || /^-0(\.0*)?$/.test(strValue)) {
      throw new BadRequestException(
        `Invalid amount at ${path.join('.')}: negative zero (-0) is not allowed. Use 0 instead.`
      );
    }

    // #663 — Also reject numeric values that lose precision when converted
    // to string (e.g. 0.1 + 0.2 = 0.30000000000000004).
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new BadRequestException(
        `Invalid amount at ${path.join('.')}: "${strValue}". Must be a finite number.`
      );
    }
  }
}
