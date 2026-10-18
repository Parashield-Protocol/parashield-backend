/**
 * Evidence file type validation (#747).
 *
 * Whitelists allowed evidence file types and validates magic bytes
 * to prevent malicious file uploads through the claims module.
 */

/**
 * Allowed evidence file types with their MIME types and magic bytes.
 */
const ALLOWED_EVIDENCE_TYPES: Record<string, { mime: string; magicBytes: number[][] }> = {
  "image/png": {
    mime: "image/png",
    magicBytes: [[0x89, 0x50, 0x4e, 0x47]], // PNG signature
  },
  "image/jpeg": {
    mime: "image/jpeg",
    magicBytes: [[0xff, 0xd8, 0xff]], // JPEG signature
  },
  "image/webp": {
    mime: "image/webp",
    magicBytes: [[0x52, 0x49, 0x46, 0x46]], // RIFF (WebP container)
  },
  "application/pdf": {
    mime: "application/pdf",
    magicBytes: [[0x25, 0x50, 0x44, 0x46]], // %PDF
  },
};

export const ALLOWED_EVIDENCE_MIME_TYPES = Object.keys(ALLOWED_EVIDENCE_TYPES);

export const MAX_EVIDENCE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export interface EvidenceValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a claim evidence file's MIME type against the whitelist.
 */
export function validateEvidenceFileType(mimeType: string): EvidenceValidationResult {
  if (!ALLOWED_EVIDENCE_TYPES[mimeType]) {
    return {
      valid: false,
      error: `File type "${mimeType}" is not allowed. Allowed types: ${ALLOWED_EVIDENCE_MIME_TYPES.join(", ")}.`,
    };
  }
  return { valid: true };
}

/**
 * Validate a claim evidence file's magic bytes (file signature).
 * Prevents disguised executables and other malicious files.
 */
export function validateEvidenceMagicBytes(
  mimeType: string,
  buffer: Buffer,
): EvidenceValidationResult {
  const typeInfo = ALLOWED_EVIDENCE_TYPES[mimeType];
  if (!typeInfo) {
    return { valid: false, error: `Unknown file type: ${mimeType}` };
  }

  if (buffer.length < 4) {
    return { valid: false, error: "File is too small to be a valid evidence file." };
  }

  const matches = typeInfo.magicBytes.some((signature) =>
    signature.every((byte, index) => buffer[index] === byte),
  );

  if (!matches) {
    return {
      valid: false,
      error: `File content does not match the declared type "${mimeType}". The file may be disguised or corrupted.`,
    };
  }

  return { valid: true };
}

/**
 * Full evidence file validation: type whitelist + magic bytes + size limit.
 */
export function validateEvidenceFile(
  mimeType: string,
  buffer: Buffer,
): EvidenceValidationResult {
  if (buffer.length > MAX_EVIDENCE_FILE_SIZE) {
    return {
      valid: false,
      error: `Evidence file exceeds ${MAX_EVIDENCE_FILE_SIZE / (1024 * 1024)}MB limit.`,
    };
  }

  const typeResult = validateEvidenceFileType(mimeType);
  if (!typeResult.valid) return typeResult;

  return validateEvidenceMagicBytes(mimeType, buffer);
}
