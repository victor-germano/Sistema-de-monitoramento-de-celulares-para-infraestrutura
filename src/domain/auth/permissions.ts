import type { Role } from '../../db/schema/usuarios.ts';

// Descreve, em texto, o que a tabela de RBAC da seção 5 já define por role.
// É metadado pro FRONTEND decidir o que esconder/mostrar por perfil (seção
// 10: "GET /auth/me ... usuário atual + role + permissões") — quem de fato
// ENFORCE acesso é `withRole(...)` em cada rota (src/plugins/rbac.ts); esta
// lista não impede nem libera nada sozinha, e cresce conforme as rotas
// reais de cada capacidade forem existindo nas próximas fases.
const VIEWER_PERMISSOES = ['inventario:ler', 'dashboards:ler', 'relatorios:ler'] as const;

const TECNICO_PERMISSOES = [
  ...VIEWER_PERMISSOES,
  'enrollment:gerar-token',
  'dispositivos:comando:lock',
  'dispositivos:comando:reboot',
  'dispositivos:comando:reset-senha',
  'dispositivos:comando:limpar-app',
  'colaboradores:vincular-dispositivo',
  'linhas:vincular-dispositivo',
] as const;

const ADMIN_PERMISSOES = [
  ...TECNICO_PERMISSOES,
  'politicas:criar',
  'politicas:editar',
  'dispositivos:comando:wipe',
  'usuarios:gerenciar',
] as const;

const AUDITOR_PERMISSOES = ['auditoria:ler', 'compliance:ler'] as const;

export const PERMISSOES_POR_ROLE: Record<Role, readonly string[]> = {
  VIEWER: VIEWER_PERMISSOES,
  TECNICO: TECNICO_PERMISSOES,
  ADMIN: ADMIN_PERMISSOES,
  AUDITOR: AUDITOR_PERMISSOES,
};
