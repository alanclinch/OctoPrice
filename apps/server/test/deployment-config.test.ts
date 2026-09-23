import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

interface D1Binding {
  binding: string;
  database_name: string;
  database_id: string;
}

interface DeploymentConfig {
  name: string;
  d1_databases: D1Binding[];
  env: {
    dev: {
      name?: string;
      d1_databases: D1Binding[];
      vars: { DEFAULT_REGION: string };
    };
  };
}

it('keeps the phone preview on a different Worker and D1 database', () => {
  const source = readFileSync(new URL('../../../wrangler.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(
    source.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'),
  ) as DeploymentConfig;

  expect(config.name).toBe('octoprice');
  expect(config.env.dev.name).not.toBe(config.name);
  expect(config.d1_databases).toHaveLength(1);
  expect(config.env.dev.d1_databases).toHaveLength(1);
  expect(config.env.dev.d1_databases[0]).toMatchObject({
    binding: 'DB',
    database_name: 'octoprice-dev',
  });
  expect(config.env.dev.d1_databases[0]?.database_id).not.toBe(config.d1_databases[0]?.database_id);
  expect(config.env.dev.vars.DEFAULT_REGION).toBe('N');
});
