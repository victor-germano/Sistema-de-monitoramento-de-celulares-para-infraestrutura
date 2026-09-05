// Barrel de todo o schema — o que `db/client.ts` e `drizzle.config.ts`
// esperam encontrar aqui. Um arquivo por domínio (seção 6 da spec),
// re-exportado como namespace pra manter os módulos de origem no
// autocomplete (`schema.usuarios`, `schema.dispositivos`, ...).
export * from './usuarios.ts';
export * from './refresh-tokens.ts';
export * from './colaboradores.ts';
export * from './linhas.ts';
export * from './politicas.ts';
export * from './dispositivos.ts';
export * from './comandos.ts';
export * from './enrollment-tokens.ts';
export * from './alertas.ts';
export * from './auditoria.ts';
export * from './eventos-brutos.ts';
