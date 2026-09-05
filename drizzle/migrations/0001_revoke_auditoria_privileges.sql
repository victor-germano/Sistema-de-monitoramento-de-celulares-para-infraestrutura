-- Custom SQL migration file, put your code below! --

-- Seção 6 da spec: "auditoria: emita REVOKE UPDATE, DELETE para o usuário
-- da aplicação no Postgres. Documente isso na própria migration."
--
-- `auditoria` é append-only por definição de produto: nenhuma rota do
-- sistema jamais deve alterar ou apagar um registro de auditoria já
-- gravado, nem para role ADMIN. Isso não é garantido "por disciplina do
-- código" — é garantido pelo próprio banco, do mesmo jeito que a seção 3
-- garante o invariante de apps via `enforceInvariants` em vez de confiar
-- que ninguém vai esquecer de chamar a função.
--
-- ACHADO DURANTE A VALIDAÇÃO DESTA FASE (ver ADR-008 em docs/DECISOES.md):
-- testei a abordagem literal da spec — só o REVOKE abaixo — contra um
-- Postgres real, com INSERT/UPDATE/DELETE de verdade. UPDATE e DELETE
-- passaram MESMO ASSIM. Causa: a role da aplicação (`CURRENT_USER` aqui) é
-- a MESMA role que criou a tabela (dona dela) — não existe, neste projeto,
-- uma role de "aplicação" separada de uma role de "migração"/dono. No
-- Postgres, o dono de uma tabela retém acesso implícito às operações
-- básicas (SELECT/INSERT/UPDATE/DELETE) independente do que for revogado
-- dele via GRANT/REVOKE — REVOKE só é eficaz contra roles que NÃO são a
-- dona do objeto. Manter o REVOKE mesmo assim (é inofensivo e correto no
-- dia em que o projeto separar role de app e role de migração — trabalho
-- futuro, não coberto por esta fase), mas quem de fato impede UPDATE/DELETE
-- é o trigger abaixo, que funciona independente de ownership.
REVOKE UPDATE, DELETE ON TABLE "auditoria" FROM CURRENT_USER;

-- Mecanismo que efetivamente bloqueia: trigger BEFORE UPDATE/DELETE que
-- sempre lança exceção. Roda pra qualquer role, incluindo o dono da tabela
-- — é o que faz "append-only" valer contra a limitação do REVOKE acima.
CREATE OR REPLACE FUNCTION auditoria_bloquear_update_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'auditoria é append-only: % não é permitido (id=%)', TG_OP, OLD.id
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auditoria_impedir_update
  BEFORE UPDATE ON "auditoria"
  FOR EACH ROW EXECUTE FUNCTION auditoria_bloquear_update_delete();

CREATE TRIGGER auditoria_impedir_delete
  BEFORE DELETE ON "auditoria"
  FOR EACH ROW EXECUTE FUNCTION auditoria_bloquear_update_delete();
