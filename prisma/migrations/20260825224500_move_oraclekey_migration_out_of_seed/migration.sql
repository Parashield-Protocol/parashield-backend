-- Data migration: Identify policies with legacy 'rainfall:1' oracleKey and update them
UPDATE "Policy" SET "oracleKey" = 'rainfall:-0.0917,34.7679:2026-06'
WHERE "oracleKey" = 'rainfall:1';
