ALTER TABLE "alertas" ALTER COLUMN "dispositivo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alertas" ADD COLUMN "linha_id" uuid;--> statement-breakpoint
ALTER TABLE "alertas" ADD CONSTRAINT "alertas_linha_id_linhas_id_fk" FOREIGN KEY ("linha_id") REFERENCES "public"."linhas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alertas_linha_aberto_unico_idx" ON "alertas" USING btree ("linha_id","tipo") WHERE "alertas"."resolvido_em" is null;--> statement-breakpoint
ALTER TABLE "alertas" ADD CONSTRAINT "alertas_dispositivo_ou_linha_check" CHECK (("alertas"."dispositivo_id" is not null) <> ("alertas"."linha_id" is not null));