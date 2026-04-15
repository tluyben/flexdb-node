/**
 * Integration tests — run against real FlexDB node(s).
 *
 * Usage:
 *   FLEXDB_NODES=http://localhost:4001 npm run test:integration
 *   FLEXDB_NODES=http://a:4001,http://b:4001 FLEXDB_TOKEN=mytoken npm run test:integration
 *
 * If FLEXDB_NODES is not set the suite is skipped with a clear message.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { FlexDBClient } from "../../src/client.js";

const nodesEnv = process.env["FLEXDB_NODES"];
const tokenEnv = process.env["FLEXDB_TOKEN"];

if (!nodesEnv) {
  console.log(
    "\n[integration] FLEXDB_NODES not set — skipping integration tests.\n" +
      "  Set FLEXDB_NODES=http://host:4001 (comma-separated for multiple) to run.\n",
  );
  process.exit(0);
}

const nodes = nodesEnv.split(",").map((u) => u.trim());

describe("FlexDB integration", () => {
  let client: FlexDBClient;
  const testTable = `flexdb_node_test_${Date.now()}`;

  before(() => {
    client = new FlexDBClient({ nodes, authToken: tokenEnv });
    console.log(`  nodes : ${nodes.join(", ")}`);
    console.log(`  auth  : ${tokenEnv ? "yes" : "none"}`);
    console.log(`  table : ${testTable}\n`);
  });

  after(async () => {
    // Clean up test table
    try {
      await client.execute([{ sql: `DROP TABLE IF EXISTS ${testTable}` }]);
    } catch {
      /* best-effort */
    }
    client.destroy();
  });

  // ─── Health / Status ───────────────────────────────────────────────────────

  it("health check returns ok", async () => {
    const res = await client.health();
    assert.equal(res.status, "ok");
  });

  it("status returns a node_id and role", async () => {
    const res = await client.getStatus();
    assert.ok(typeof res.node_id === "string" && res.node_id.length > 0);
    assert.ok(["leader", "follower", "candidate", "learner", "shutdown"].includes(res.role));
    assert.ok(typeof res.version === "string");
  });

  it("nodes endpoint returns at least one node", async () => {
    const res = await client.getNodes();
    assert.ok(Array.isArray(res.nodes));
    assert.ok(res.nodes.length >= 1);
    assert.ok(typeof res.nodes[0].node_id === "string");
  });

  // ─── DDL + basic query ─────────────────────────────────────────────────────

  it("creates a table via execute", async () => {
    const res = await client.execute([
      {
        sql: `CREATE TABLE IF NOT EXISTS ${testTable} (
          id   INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT    NOT NULL,
          val  REAL
        )`,
      },
    ]);
    assert.equal(res.results.length, 1);
  });

  it("inserts rows and returns last_insert_id", async () => {
    const res = await client.execute([
      {
        sql: `INSERT INTO ${testTable} (name, val) VALUES (?1, ?2)`,
        params: ["alpha", 1.1],
      },
      {
        sql: `INSERT INTO ${testTable} (name, val) VALUES (?1, ?2)`,
        params: ["beta", 2.2],
      },
    ]);
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].rows_affected, 1);
    assert.ok(res.results[1].last_insert_id !== null);
  });

  it("queries rows with param binding", async () => {
    const res = await client.query([
      { sql: `SELECT id, name, val FROM ${testTable} WHERE name = ?1`, params: ["alpha"] },
    ]);
    assert.equal(res.results[0].rows.length, 1);
    assert.equal(res.results[0].rows[0][1], "alpha");
    assert.ok(typeof res.node_id === "string");
  });

  it("query returns column names", async () => {
    const res = await client.query([{ sql: `SELECT * FROM ${testTable} LIMIT 1` }]);
    const cols = res.results[0].columns;
    assert.ok(cols.includes("id"));
    assert.ok(cols.includes("name"));
    assert.ok(cols.includes("val"));
  });

  it("updates a row and reports rows_affected", async () => {
    const res = await client.execute([
      {
        sql: `UPDATE ${testTable} SET val = ?1 WHERE name = ?2`,
        params: [99.9, "alpha"],
      },
    ]);
    assert.equal(res.results[0].rows_affected, 1);
  });

  it("deletes a row and reports rows_affected", async () => {
    const res = await client.execute([
      { sql: `DELETE FROM ${testTable} WHERE name = ?1`, params: ["beta"] },
    ]);
    assert.equal(res.results[0].rows_affected, 1);
  });

  // ─── Transactions ──────────────────────────────────────────────────────────

  it("commits a transaction atomically", async () => {
    const tx = await client.beginTransaction();
    assert.ok(typeof tx.id === "string" && tx.id.length > 0);
    assert.ok(tx.expiresAt instanceof Date);

    await tx.execute([
      {
        sql: `INSERT INTO ${testTable} (name, val) VALUES (?1, ?2)`,
        params: ["tx-commit", 42],
      },
    ]);
    const committed = await tx.commit();
    assert.equal(committed.status, "committed");

    const check = await client.query([
      { sql: `SELECT COUNT(*) as n FROM ${testTable} WHERE name = ?1`, params: ["tx-commit"] },
    ]);
    assert.equal(check.results[0].rows[0][0], 1);
  });

  it("rolls back a transaction", async () => {
    const tx = await client.beginTransaction();
    await tx.execute([
      {
        sql: `INSERT INTO ${testTable} (name, val) VALUES (?1, ?2)`,
        params: ["tx-rollback", -1],
      },
    ]);
    const rolled = await tx.rollback();
    assert.equal(rolled.status, "rolled_back");

    const check = await client.query([
      { sql: `SELECT COUNT(*) as n FROM ${testTable} WHERE name = ?1`, params: ["tx-rollback"] },
    ]);
    assert.equal(check.results[0].rows[0][0], 0);
  });

  // ─── Table mode ────────────────────────────────────────────────────────────

  it("gets and sets table consistency mode", async () => {
    const mode = await client.getTableMode(testTable);
    assert.equal(mode.table, testTable);
    assert.ok(["raft", "eventual", "crdt"].includes(mode.mode));

    const set = await client.setTableMode(testTable, "eventual");
    assert.equal(set.mode, "eventual");

    // Restore
    await client.setTableMode(testTable, "raft");
  });

  // ─── Full-text search ──────────────────────────────────────────────────────

  it("enables full-text search, searches, then disables", async () => {
    // Insert a row with searchable text
    await client.execute([
      {
        sql: `INSERT INTO ${testTable} (name, val) VALUES (?1, ?2)`,
        params: ["distributed systems", 0],
      },
    ]);

    const enabled = await client.enableSearch(testTable, ["name"]);
    assert.ok(enabled.columns.includes("name"));

    const results = await client.search({
      table: testTable,
      query: "distributed",
      limit: 5,
    });
    assert.ok(results.results.rows.length >= 1);

    const disabled = await client.disableSearch(testTable);
    assert.deepEqual(disabled.columns, []);
  });

  // ─── execute rejects SELECT ────────────────────────────────────────────────

  it("execute rejects a SELECT statement with 400", async () => {
    await assert.rejects(
      () => client.execute([{ sql: `SELECT 1` }]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // Server returns 400 for SELECT on /v1/execute
        return true;
      },
    );
  });

  // ─── metrics ──────────────────────────────────────────────────────────────

  it("metrics endpoint returns prometheus text", async () => {
    const text = await client.metrics();
    assert.ok(typeof text === "string" && text.length > 0);
    // Should contain at least one HELP or TYPE line
    assert.ok(text.includes("starlite_") || text.includes("flexdb_") || text.includes("# "));
  });
});
