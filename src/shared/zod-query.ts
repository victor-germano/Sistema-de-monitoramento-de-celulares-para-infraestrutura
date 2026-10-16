import { z } from 'zod';

// `z.coerce.boolean()` faz `Boolean(valorCru)` — qualquer string não-vazia,
// incluindo a string `"false"`, vira `true` (achado numa revisão de
// segurança: `?ativo=false`/`?ativa=false`/`?aberto=false` faziam o
// contrário do pedido em 3 rotas). Query string só chega como texto —
// comparar contra os dois valores literais é o jeito correto de interpretar
// um filtro booleano vindo de `?campo=true|false`.
export const zQueryBoolean = z.enum(['true', 'false']).transform((valor) => valor === 'true');
