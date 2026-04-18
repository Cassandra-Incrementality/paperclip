-- Wiki knowledge layer (idempotent — columns may already exist from a prior install)

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'manual';
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "summary" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "tags" text[];
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "confidence" real NOT NULL DEFAULT 1.0;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_count" integer NOT NULL DEFAULT 1;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "decay_tier" text NOT NULL DEFAULT 'episodic';
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "last_reinforced_at" timestamp with time zone;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "superseded_by_id" uuid;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_issue_id" uuid;
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_superseded_by_id_fkey'
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_superseded_by_id_fkey"
      FOREIGN KEY ("superseded_by_id") REFERENCES "documents"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "documents_company_kind_idx" ON "documents" USING btree ("company_id", "kind");
CREATE INDEX IF NOT EXISTS "documents_company_decay_tier_idx" ON "documents" USING btree ("company_id", "decay_tier");
CREATE INDEX IF NOT EXISTS "documents_tags_idx" ON "documents" USING gin ("tags");
CREATE INDEX IF NOT EXISTS "documents_summary_search_idx" ON "documents" USING gin ("summary" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "documents_title_search_idx" ON "documents" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "documents_body_search_idx" ON "documents" USING gin ("latest_body" gin_trgm_ops);
