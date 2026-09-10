import type { ClientBase } from "pg";

export async function setClock(client: ClientBase, iso: string | null): Promise<void> {
  await client.query("select set_config('dastar.now', $1, false)", [iso ?? ""]);
}
