CREATE TYPE "public"."alerta_severidade" AS ENUM('ALTA', 'MEDIA', 'BAIXA');--> statement-breakpoint
CREATE TYPE "public"."alerta_tipo" AS ENUM('SEM_CHECKIN', 'NAO_CONFORME', 'APP_OBRIGATORIO_AUSENTE', 'PATCH_DESATUALIZADO', 'SO_OBSOLETO', 'STORAGE_CRITICO', 'DISPOSITIVO_ORFAO', 'LINHA_SEM_USO', 'BATERIA_DEGRADADA');--> statement-breakpoint
CREATE TYPE "public"."comando_status" AS ENUM('PENDENTE', 'ENVIADO', 'SUCESSO', 'FALHA');--> statement-breakpoint
CREATE TYPE "public"."comando_tipo" AS ENUM('LOCK', 'REBOOT', 'RESET_PASSWORD', 'RELINQUISH_OWNERSHIP', 'CLEAR_APP_DATA', 'WIPE');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR');--> statement-breakpoint
CREATE TYPE "public"."linha_status" AS ENUM('ativa', 'suspensa', 'cancelada');--> statement-breakpoint
CREATE TABLE "alertas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dispositivo_id" uuid NOT NULL,
	"tipo" "alerta_tipo" NOT NULL,
	"severidade" "alerta_severidade" NOT NULL,
	"titulo" text NOT NULL,
	"detalhes" jsonb,
	"reconhecido_por" uuid,
	"reconhecido_em" timestamp with time zone,
	"resolvido_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditoria" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ator_id" uuid,
	"ator_email" text,
	"acao" text NOT NULL,
	"entidade" text NOT NULL,
	"entidade_id" text,
	"detalhes" jsonb,
	"ip" text,
	"user_agent" text,
	"ocorrido_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "colaboradores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"matricula" text NOT NULL,
	"nome" text NOT NULL,
	"email" text,
	"filial" text,
	"departamento" text,
	"centro_custo" text,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comandos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dispositivo_id" uuid NOT NULL,
	"tipo" "comando_tipo" NOT NULL,
	"payload" jsonb,
	"amapi_operation_name" text,
	"status" "comando_status" DEFAULT 'PENDENTE' NOT NULL,
	"erro" text,
	"solicitado_por" uuid NOT NULL,
	"solicitado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"concluido_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dispositivo_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dispositivo_id" uuid NOT NULL,
	"package_name" text NOT NULL,
	"nome_exibicao" text,
	"versao" text,
	"install_type" text,
	"estado" text,
	"coletado_em" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispositivos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"amapi_name" text NOT NULL,
	"imei" text,
	"serial" text,
	"patrimonio" text,
	"fabricante" text,
	"modelo" text,
	"versao_so" text,
	"patch_seguranca" date,
	"estado" text,
	"compliance_state" text,
	"policy_compliant" boolean,
	"bateria_pct" integer,
	"storage_total_mb" integer,
	"storage_livre_mb" integer,
	"ultimo_checkin" timestamp with time zone,
	"ultima_localizacao" jsonb,
	"colaborador_id" uuid,
	"linha_id" uuid,
	"politica_id" uuid,
	"data_aquisicao" date,
	"fim_garantia" date,
	"valor_aquisicao" numeric(12, 2),
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollment_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"amapi_token_name" text,
	"valor_hash" text NOT NULL,
	"politica_id" uuid,
	"patrimonio" text,
	"colaborador_id" uuid,
	"expira_em" timestamp with time zone NOT NULL,
	"usado_em" timestamp with time zone,
	"dispositivo_id" uuid,
	"criado_por" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eventos_brutos" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"notification_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"message_id" text NOT NULL,
	"processado_em" timestamp with time zone,
	"erro" text
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"oidc_subject" text NOT NULL,
	"email" text NOT NULL,
	"nome" text NOT NULL,
	"role" "role" DEFAULT 'VIEWER' NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"ultimo_login" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"usuario_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"revogado_em" timestamp with time zone,
	"substituido_por" uuid,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "linhas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"numero" text NOT NULL,
	"operadora" text,
	"iccid" text,
	"plano_dados_gb" integer,
	"valor_mensal" numeric(10, 2),
	"status" "linha_status" DEFAULT 'ativa' NOT NULL,
	"data_ativacao" date,
	"observacoes" text
);
--> statement-breakpoint
CREATE TABLE "politicas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nome" text NOT NULL,
	"amapi_name" text,
	"descricao" text,
	"payload" jsonb NOT NULL,
	"versao" integer DEFAULT 1 NOT NULL,
	"ativa" boolean DEFAULT true NOT NULL,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "politicas_versoes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"politica_id" uuid NOT NULL,
	"versao" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"diff_resumo" text,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alertas" ADD CONSTRAINT "alertas_dispositivo_id_dispositivos_id_fk" FOREIGN KEY ("dispositivo_id") REFERENCES "public"."dispositivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comandos" ADD CONSTRAINT "comandos_dispositivo_id_dispositivos_id_fk" FOREIGN KEY ("dispositivo_id") REFERENCES "public"."dispositivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comandos" ADD CONSTRAINT "comandos_solicitado_por_usuarios_id_fk" FOREIGN KEY ("solicitado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispositivo_apps" ADD CONSTRAINT "dispositivo_apps_dispositivo_id_dispositivos_id_fk" FOREIGN KEY ("dispositivo_id") REFERENCES "public"."dispositivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispositivos" ADD CONSTRAINT "dispositivos_colaborador_id_colaboradores_id_fk" FOREIGN KEY ("colaborador_id") REFERENCES "public"."colaboradores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispositivos" ADD CONSTRAINT "dispositivos_linha_id_linhas_id_fk" FOREIGN KEY ("linha_id") REFERENCES "public"."linhas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispositivos" ADD CONSTRAINT "dispositivos_politica_id_politicas_id_fk" FOREIGN KEY ("politica_id") REFERENCES "public"."politicas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_politica_id_politicas_id_fk" FOREIGN KEY ("politica_id") REFERENCES "public"."politicas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_colaborador_id_colaboradores_id_fk" FOREIGN KEY ("colaborador_id") REFERENCES "public"."colaboradores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_dispositivo_id_dispositivos_id_fk" FOREIGN KEY ("dispositivo_id") REFERENCES "public"."dispositivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_substituido_por_refresh_tokens_id_fk" FOREIGN KEY ("substituido_por") REFERENCES "public"."refresh_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "politicas" ADD CONSTRAINT "politicas_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "politicas_versoes" ADD CONSTRAINT "politicas_versoes_politica_id_politicas_id_fk" FOREIGN KEY ("politica_id") REFERENCES "public"."politicas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "politicas_versoes" ADD CONSTRAINT "politicas_versoes_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alertas_resolvido_em_aberto_idx" ON "alertas" USING btree ("resolvido_em") WHERE "alertas"."resolvido_em" is null;--> statement-breakpoint
CREATE INDEX "auditoria_ocorrido_em_idx" ON "auditoria" USING btree ("ocorrido_em" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auditoria_entidade_idx" ON "auditoria" USING btree ("entidade","entidade_id");--> statement-breakpoint
CREATE UNIQUE INDEX "colaboradores_matricula_idx" ON "colaboradores" USING btree ("matricula");--> statement-breakpoint
CREATE UNIQUE INDEX "dispositivo_apps_dispositivo_package_idx" ON "dispositivo_apps" USING btree ("dispositivo_id","package_name");--> statement-breakpoint
CREATE UNIQUE INDEX "dispositivos_amapi_name_idx" ON "dispositivos" USING btree ("amapi_name");--> statement-breakpoint
CREATE UNIQUE INDEX "dispositivos_patrimonio_idx" ON "dispositivos" USING btree ("patrimonio");--> statement-breakpoint
CREATE INDEX "dispositivos_ultimo_checkin_idx" ON "dispositivos" USING btree ("ultimo_checkin" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dispositivos_colaborador_id_idx" ON "dispositivos" USING btree ("colaborador_id");--> statement-breakpoint
CREATE INDEX "dispositivos_compliance_state_idx" ON "dispositivos" USING btree ("compliance_state");--> statement-breakpoint
CREATE UNIQUE INDEX "eventos_brutos_message_id_idx" ON "eventos_brutos" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usuarios_oidc_subject_idx" ON "usuarios" USING btree ("oidc_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "linhas_numero_idx" ON "linhas" USING btree ("numero");--> statement-breakpoint
CREATE UNIQUE INDEX "politicas_nome_idx" ON "politicas" USING btree ("nome");