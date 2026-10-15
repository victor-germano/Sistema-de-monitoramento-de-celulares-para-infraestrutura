// Gera docs/openapi.json a partir dos schemas Zod declarados em cada rota —
// fonte única de verdade é o código (src/modules/*/*.routes.ts), não um
// documento mantido à mão em paralelo. Rodar de novo sempre que uma rota
// mudar: `npx tsx scripts/gerar-openapi.ts` (requer Postgres/Redis no ar,
// ver README "Rodando localmente" — nenhuma query roda de fato, mas o
// cliente Redis conecta no import do módulo).
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.ts';

async function main(): Promise<void> {
  const app = await buildApp();
  await app.ready();
  const spec = app.swagger();
  await writeFile('docs/openapi.json', JSON.stringify(spec, null, 2) + '\n', 'utf-8');
  console.log('docs/openapi.json gerado.');
  await app.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
