import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "../src/migrate.js";

const here = dirname(fileURLToPath(import.meta.url));
let container: StartedPostgreSqlContainer;

export async function setup() {
  container = await new PostgreSqlContainer("postgres:18")
    .withUsername("dastar_owner")
    .withPassword("owner")
    .withDatabase("postgres")
    .withCommand(["postgres", "-c", "max_connections=200", "-c", "deadlock_timeout=200ms"])
    .start();
  const base = `postgres://dastar_owner:owner@${container.getHost()}:${container.getPort()}`;
  const admin = new Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query("create database dastar_template");
  await admin.end();

  const templateOwner = `${base}/dastar_template`;
  await migrate(templateOwner, join(here, "..", "migrations"));

  const t = new Client({ connectionString: templateOwner });
  await t.connect();
  await t.query("alter role dastar_app password 'app'");
  await t.query("alter role dastar_worker password 'worker'");
  await t.query("alter role dastar_readonly password 'readonly'");
  await t.query(await readFile(join(here, "..", "test-sql", "clock_override.sql"), "utf8"));
  await t.end();

  process.env.DASTAR_TEST_PG_BASE = base;
  process.env.DASTAR_TEST_PG_HOSTPORT = `${container.getHost()}:${container.getPort()}`;
}

export async function teardown() {
  await container?.stop();
}
