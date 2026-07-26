-- #164/#166: PolicyStatus needs a transient PROCESSING value for the atomic
-- claims-processing gate in ClaimsService.autoProcess/submitClaim. Postgres
-- requires ALTER TYPE ... ADD VALUE to run outside an explicit transaction
-- block (and, for older Postgres, in its own statement), matching the
-- generated form `prisma migrate dev` produces for enum additions.
ALTER TYPE "PolicyStatus" ADD VALUE 'PROCESSING';
