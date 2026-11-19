-- Field-update audit entries (for example an oracle key or time change) are not status
-- transitions, so they store NULL instead of repeating the current status (#847).
ALTER TABLE "AuditLog" ALTER COLUMN "fromStatus" DROP NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "toStatus" DROP NOT NULL;
