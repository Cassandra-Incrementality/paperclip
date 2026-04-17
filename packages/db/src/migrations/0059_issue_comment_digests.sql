CREATE TABLE "issue_comment_digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"digest" text,
	"digested_through" uuid,
	"digested_count" integer DEFAULT 0 NOT NULL,
	"model" text,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"generating_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_comment_digests" ADD CONSTRAINT "issue_comment_digests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_digests" ADD CONSTRAINT "issue_comment_digests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_digests" ADD CONSTRAINT "issue_comment_digests_digested_through_issue_comments_id_fk" FOREIGN KEY ("digested_through") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_digests_issue_uq" ON "issue_comment_digests" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_comment_digests_company_idx" ON "issue_comment_digests" USING btree ("company_id");
