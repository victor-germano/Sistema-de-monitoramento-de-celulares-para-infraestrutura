import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as PoliticasSchemaModule from '../../src/db/schema/politicas.ts';
import type * as SeedModule from '../../src/db/seed/politicas-padrao.ts';

let postgresContainer: StartedPostgreSqlContainer;
let db: typeof DbClientModule.db;
let politicas: typeof PoliticasSchemaModule.politicas;
let seedPoliticasPadrao: typeof SeedModule.seedPoliticasPadrao;

beforeAll(async () => {
  postgresContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = postgresContainer.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6379';

  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  ({ db } = await import('../../src/db/client.ts'));
  ({ politicas } = await import('../../src/db/schema/politicas.ts'));
  ({ seedPoliticasPadrao } = await import('../../src/db/seed/politicas-padrao.ts'));

  await migrate(db, { migrationsFolder: './drizzle/migrations' });
}, 60_000);

afterAll(async () => {
  await postgresContainer?.stop();
});

describe('seedPoliticasPadrao', () => {
  it('cria as duas políticas padrão com os invariantes já aplicados', async () => {
    await seedPoliticasPadrao();

    const linhas = await db.select().from(politicas);
    expect(linhas.map((p) => p.nome).sort()).toEqual(['administrativo', 'operacao-campo']);

    for (const politica of linhas) {
      const payload = politica.payload as {
        uninstallAppsDisabled?: boolean;
        installAppsDisabled?: boolean;
        playStoreMode?: string;
        installUnknownSourcesAllowed?: boolean;
      };
      expect(payload.uninstallAppsDisabled).toBe(true);
      expect(payload.installAppsDisabled).toBe(false);
      expect(payload.playStoreMode).toBe('WHITELIST');
      expect(payload.installUnknownSourcesAllowed).toBe(false);
      expect(politica.ativa).toBe(true);
      expect(politica.versao).toBe(1);
    }
  });

  it('é idempotente — rodar de novo não duplica nem falha', async () => {
    await seedPoliticasPadrao();
    await seedPoliticasPadrao();

    const linhas = await db.select().from(politicas);
    expect(linhas).toHaveLength(2);
  });
});
