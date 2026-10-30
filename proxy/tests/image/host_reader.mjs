// Host-side reader for the image check: queries a session database through the MCP tool code while the
// container writes it. Usage: node host_reader.mjs <session_id> <rounds>. Prints one JSON summary line.
import { callContextStoreTool } from "../../../cli/mcp/context-store.mjs";

const [sid, rounds = "20"] = process.argv.slice(2);
const summary = { rounds: Number(rounds), searches: 0, sqls: 0, errors: [], counts: [] };
for (let i = 0; i < summary.rounds; i++) {
  try {
    const found = await callContextStoreTool("smart_compact_search", { session_id: sid, query: "marker", mode: "lexical" });
    if (Array.isArray(found.results)) summary.searches++;
    const sql = await callContextStoreTool("smart_compact_sql", { session_id: sid, sql: "SELECT count(*) AS n FROM messages" });
    summary.counts.push(sql.rows[0]?.n ?? sql.rows[0]?.[0]);
    summary.sqls++;
  } catch (err) {
    summary.errors.push(String(err?.message || err));
  }
  await new Promise((r) => setTimeout(r, 50));
}
process.stdout.write(`${JSON.stringify(summary)}\n`);
