ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_substituido_por_refresh_tokens_id_fk";
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_substituido_por_refresh_tokens_id_fk" FOREIGN KEY ("substituido_por") REFERENCES "public"."refresh_tokens"("id") ON DELETE set null ON UPDATE no action;