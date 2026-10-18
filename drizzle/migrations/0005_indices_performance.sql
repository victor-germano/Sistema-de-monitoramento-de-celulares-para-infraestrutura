CREATE INDEX "comandos_dispositivo_id_idx" ON "comandos" USING btree ("dispositivo_id");--> statement-breakpoint
CREATE INDEX "dispositivos_politica_id_idx" ON "dispositivos" USING btree ("politica_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_token_hash_idx" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "politicas_versoes_politica_id_idx" ON "politicas_versoes" USING btree ("politica_id");