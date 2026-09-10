import { Client } from "pg";

function base(): string {
  const b = process.env.DASTAR_TEST_PG_BASE;
  if (!b) throw new Error("global setup did not run");
  return b;
}
function hostport(): string {
  return process.env.DASTAR_TEST_PG_HOSTPORT!;
}

export type Conn = { owner: string; app: string; worker: string; readonly: string; name: string };

function connectionsFor(name: string): Conn {
  const hp = hostport();
  return {
    name,
    owner: `postgres://dastar_owner:owner@${hp}/${name}`,
    app: `postgres://dastar_app:app@${hp}/${name}`,
    worker: `postgres://dastar_worker:worker@${hp}/${name}`,
    readonly: `postgres://dastar_readonly:readonly@${hp}/${name}`,
  };
}

export async function cloneDatabase(name: string): Promise<Conn> {
  const admin = new Client({ connectionString: `${base()}/postgres` });
  await admin.connect();
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}" template dastar_template`);
  await admin.end();
  return connectionsFor(name);
}

export async function createEmptyDatabase(name: string): Promise<Conn> {
  const admin = new Client({ connectionString: `${base()}/postgres` });
  await admin.connect();
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  await admin.end();
  return connectionsFor(name);
}

export async function dropDatabase(name: string): Promise<void> {
  const admin = new Client({ connectionString: `${base()}/postgres` });
  await admin.connect();
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.end();
}

export async function connect(connectionString: string): Promise<Client> {
  const c = new Client({ connectionString });
  await c.connect();
  return c;
}
