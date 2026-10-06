const query = async (sql: string) => (await import("./db.ts")).query(sql);

const tables: Record<string, string[]> = {
  equipe: ["team"], team: ["team"],
  campeonato: ["championship"], championship: ["championship"],
  "equipe-campeonato": ["team", "championship"], "team-championship": ["team", "championship"],
  jogo: ["game"], match: ["game"], editar: ["game"], edit: ["game"],
  chances: ["stage_group"], jogador: ["player"], player: ["player"],
  estadio: ["stadium"], stadium: ["stadium"], arbitro: ["referee"], referee: ["referee"],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=[?*#]|$)/i;

// Fixture identities stay UUIDs; tests resolve their public addresses before navigation.
export async function fixturePath(path: string, read = query): Promise<string> {
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    const entities = tables[parts[index]];
    if (!entities) continue;
    for (const [offset, table] of entities.entries()) {
      const position = index + offset + 1;
      const match = uuid.exec(parts[position] ?? "");
      if (!match) continue;
      const slug = await address(table, match[0], read);
      parts[position] = slug + parts[position].slice(match[0].length);
    }
    break;
  }
  return parts.join("/");
}

export async function address(table: string, id: string, read = query): Promise<string> {
  if (!Object.values(tables).flat().includes(table) || id.length !== 36 || !uuid.test(id)) {
    throw new Error(`Invalid address fixture: ${table}/${id}`);
  }
  const slug = await read(`SELECT slug FROM ${table} WHERE id='${id}'`);
  if (!slug || slug.includes("\n")) throw new Error(`Missing or ambiguous address fixture: ${table}/${id}`);
  return slug;
}
