// Achado numa revisão de eficiência/correção: sem escapar, um usuário
// buscando por um `%`/`_` literal recebia resultado errado (os dois são
// wildcard do LIKE/ILIKE do Postgres, não caractere literal).
import { describe, expect, it } from 'vitest';
import { escaparTermoBusca } from '../../src/shared/sql-like.ts';

describe('escaparTermoBusca', () => {
  it('escapa % e _ literais', () => {
    expect(escaparTermoBusca('100%')).toBe('100\\%');
    expect(escaparTermoBusca('usuario_teste')).toBe('usuario\\_teste');
  });

  it('escapa o próprio backslash ANTES de escapar % e _ (senão duplica o escape)', () => {
    expect(escaparTermoBusca('a\\b')).toBe('a\\\\b');
    expect(escaparTermoBusca('100\\%')).toBe('100\\\\\\%');
  });

  it('não altera texto sem caractere especial', () => {
    expect(escaparTermoBusca('fulano de tal')).toBe('fulano de tal');
  });

  it('string vazia permanece vazia', () => {
    expect(escaparTermoBusca('')).toBe('');
  });
});
