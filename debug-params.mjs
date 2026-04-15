/**
 * Quick debug script — runs directly against the live cluster to check
 * whether params are bound correctly on /v1/query vs /v1/execute.
 *
 * Run with:  node debug-params.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Load cluster file ────────────────────────────────────────────────────────

const clusterPath = resolve("../keyvalue.cloud/.flexdb-cluster");
const cluster = JSON.parse(readFileSync(clusterPath, "utf8"));
const base = cluster.leader_url ?? cluster.nodes[0].http_url;
const token = cluster.auth_token;

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
};

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TABLE = `debug_params_${Date.now()}`;

async function sql(query) {
  return post("/v1/query", { statements: [{ sql: query }] });
}

async function query(sqlStr, params) {
  console.log(`  POST /v1/query  sql=${JSON.stringify(sqlStr)}  params=${JSON.stringify(params)}`);
  const body = { statements: [{ sql: sqlStr, params }] };
  console.log(`  request body: ${JSON.stringify(body)}`);
  const res = await post("/v1/query", body);
  console.log(`  rows returned: ${res.results[0].rows.length}`);
  console.log(`  rows: ${JSON.stringify(res.results[0].rows)}`);
  return res;
}

async function execute(sqlStr, params) {
  console.log(`  POST /v1/execute  sql=${JSON.stringify(sqlStr)}  params=${JSON.stringify(params)}`);
  const body = { statements: [{ sql: sqlStr, params }] };
  console.log(`  request body: ${JSON.stringify(body)}`);
  const res = await post("/v1/execute", body);
  console.log(`  rows_affected: ${res.results[0].rows_affected}`);
  return res;
}

// ── Test ─────────────────────────────────────────────────────────────────────

console.log(`\nTarget: ${base}`);
console.log(`Table:  ${TABLE}\n`);

try {
  // Setup
  console.log("── Setup ─────────────────────────────────────────────────────");
  await sql(`CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, name TEXT, val REAL)`);
  await sql(`INSERT INTO ${TABLE} VALUES (1, 'alice', 1.1)`);
  await sql(`INSERT INTO ${TABLE} VALUES (2, 'bob', 2.2)`);
  await sql(`INSERT INTO ${TABLE} VALUES (3, 'carol', 3.3)`);
  console.log("  Inserted 3 rows (alice, bob, carol)\n");

  // Test 1: /v1/query SELECT with ?1 placeholder
  console.log("── Test 1: SELECT with ?1 placeholder ────────────────────────");
  const t1 = await query(`SELECT id, name FROM ${TABLE} WHERE name = ?1`, ["bob"]);
  const t1pass = t1.results[0].rows.length === 1 && t1.results[0].rows[0][1] === "bob";
  console.log(`  RESULT: ${t1pass ? "PASS ✓" : "FAIL ✗ — expected 1 row, got " + t1.results[0].rows.length}\n`);

  // Test 2: /v1/query SELECT with anonymous ? placeholder
  console.log("── Test 2: SELECT with ? placeholder ─────────────────────────");
  const t2 = await query(`SELECT id, name FROM ${TABLE} WHERE name = ?`, ["alice"]);
  const t2pass = t2.results[0].rows.length === 1 && t2.results[0].rows[0][1] === "alice";
  console.log(`  RESULT: ${t2pass ? "PASS ✓" : "FAIL ✗ — expected 1 row, got " + t2.results[0].rows.length}\n`);

  // Test 3: /v1/query SELECT with integer param
  console.log("── Test 3: SELECT with integer param ─────────────────────────");
  const t3 = await query(`SELECT name FROM ${TABLE} WHERE id = ?1`, [2]);
  const t3pass = t3.results[0].rows.length === 1 && t3.results[0].rows[0][0] === "bob";
  console.log(`  RESULT: ${t3pass ? "PASS ✓" : "FAIL ✗ — expected 'bob', got " + JSON.stringify(t3.results[0].rows)}\n`);

  // Test 4: /v1/query with no params (sanity check — should return all 3)
  console.log("── Test 4: SELECT without params (sanity) ────────────────────");
  const t4 = await query(`SELECT id, name FROM ${TABLE}`, []);
  const t4pass = t4.results[0].rows.length === 3;
  console.log(`  RESULT: ${t4pass ? "PASS ✓" : "FAIL ✗ — expected 3 rows, got " + t4.results[0].rows.length}\n`);

  // Test 5: /v1/execute UPDATE with params (known-working baseline)
  console.log("── Test 5: /v1/execute UPDATE with params (baseline) ─────────");
  const t5 = await execute(`UPDATE ${TABLE} SET val = ?1 WHERE name = ?2`, [99.9, "carol"]);
  const t5pass = t5.results[0].rows_affected === 1;
  console.log(`  RESULT: ${t5pass ? "PASS ✓" : "FAIL ✗"}\n`);

  // Summary
  console.log("── Summary ───────────────────────────────────────────────────");
  const all = [t1pass, t2pass, t3pass, t4pass, t5pass];
  const labels = ["SELECT ?1", "SELECT ?", "SELECT int param", "SELECT no params", "EXECUTE baseline"];
  all.forEach((p, i) => console.log(`  ${labels[i]}: ${p ? "PASS ✓" : "FAIL ✗"}`));

} finally {
  // Cleanup
  console.log("\n── Cleanup ───────────────────────────────────────────────────");
  try {
    await sql(`DROP TABLE IF EXISTS ${TABLE}`);
    console.log("  Dropped test table.");
  } catch (e) {
    console.log(`  Cleanup failed: ${e.message}`);
  }
}
