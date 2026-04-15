# flexdb-node

Official Node.js client for [FlexDB](https://github.com/tychoish/flexdb) — zero runtime dependencies, TypeScript-first.

## Requirements

- Node.js 18+ (uses built-in `fetch`)
- FlexDB node(s) reachable over HTTP

## Installation

```sh
npm install flexdb-node
```

## Quick start

```ts
import { FlexDBClient } from "flexdb-node";

const db = new FlexDBClient({
  nodes: "http://localhost:4001",
  authToken: "my-secret-token", // omit if auth is disabled
});

// Single statement
const { results } = await db.query({ sql: "SELECT 1 + 1 AS n" });
console.log(results[0].rows); // [[2]]

db.destroy(); // stops background health checks
```

### Connect from a `.flexdb-cluster` file

Cluster-provisioning scripts (e.g. `start-auto-raft-do`) write a `.flexdb-cluster`
JSON file in the directory where they are invoked. `fromClusterFile()` walks up
from `process.cwd()` to find it automatically — no arguments needed in the
happy path:

```ts
import { FlexDBClient } from "flexdb-node";

// auto-discovers .flexdb-cluster in cwd or any parent directory
const db = FlexDBClient.fromClusterFile();

// explicit path
const db2 = FlexDBClient.fromClusterFile("/path/to/.flexdb-cluster");
```

The factory reads `nodes[].http_url` for the node list and `auth_token` for auth.
All nodes are used in round-robin with background health checks.

## Multi-node clusters

Pass an array of URLs. The client round-robins over healthy nodes and runs
background health checks every 10 seconds:

```ts
const db = new FlexDBClient({
  nodes: [
    "http://10.0.0.1:4001",
    "http://10.0.0.2:4001",
    "http://10.0.0.3:4001",
  ],
  authToken: "secret",
  healthCheckIntervalMs: 5_000, // default 10_000
  timeoutMs: 15_000,            // default 30_000
});
```

## API

### `db.query(statements, consistency?)`

Execute SQL (reads or writes). `statements` can be a single object or an array.

```ts
// Single
await db.query({ sql: "SELECT * FROM users WHERE id = ?1", params: [42] });

// Batch
await db.query([
  { sql: "SELECT count(*) FROM orders" },
  { sql: "SELECT count(*) FROM products" },
]);

// Override consistency
await db.query({ sql: "SELECT ..." }, "eventual");
```

### `db.execute(statements)`

Like `query` but rejects SELECT — useful for enforcing write-only paths.

```ts
await db.execute({
  sql: "INSERT INTO users (name) VALUES (?1)",
  params: ["Alice"],
});
```

### Transactions

Only tables in `raft` mode support transactions.

```ts
const tx = await db.beginTransaction();
try {
  await tx.execute({ sql: "UPDATE accounts SET balance = balance - ?1 WHERE id = ?2", params: [100, 1] });
  await tx.execute({ sql: "UPDATE accounts SET balance = balance + ?1 WHERE id = ?2", params: [100, 2] });
  await tx.commit();
} catch (err) {
  await tx.rollback();
  throw err;
}
```

### Table modes

```ts
// Get
const { mode } = await db.getTableMode("my_table");

// Set to eventual
await db.setTableMode("my_table", "eventual");

// Set to CRDT with last-write-wins
await db.setTableMode("my_table", "crdt", "lww");
```

### Full-text search

```ts
// Enable FTS on columns
await db.enableSearch("articles", ["title", "body"]);

// Search
const { results } = await db.search({
  table: "articles",
  query: "distributed systems",
  limit: 10,
});

// Disable
await db.disableSearch("articles");
```

### Cluster / observability

```ts
await db.health();   // { status: "ok" }
await db.getStatus(); // node role, raft index, active transactions, …
await db.getNodes();  // all cluster nodes
await db.metrics();  // raw Prometheus text
```

### Analytics (requires FlexDB analytics feature)

```ts
await db.listAnalytics();
await db.getAnalyticsTable("daily_sales");
await db.rebuildAnalyticsTable("daily_sales");
```

## Error types

```ts
import {
  FlexDBError,
  FlexDBAuthError,
  FlexDBNoLeaderError,
  FlexDBTransactionError,
  FlexDBNoHealthyNodeError,
  FlexDBTimeoutError,
} from "flexdb-node";

try {
  await db.query({ sql: "SELECT 1" });
} catch (err) {
  if (err instanceof FlexDBAuthError)         console.error("check your auth token");
  if (err instanceof FlexDBNoLeaderError)     console.error("cluster is electing a leader");
  if (err instanceof FlexDBNoHealthyNodeError) console.error("all nodes are unreachable");
  if (err instanceof FlexDBTimeoutError)      console.error("request timed out");
  if (err instanceof FlexDBTransactionError)  console.error("transaction error:", err.message);
  if (err instanceof FlexDBError)             console.error(err.statusCode, err.message);
}
```

## Running tests

### Unit tests (no server required)

```sh
npm test
```

### Integration tests (requires a running FlexDB node)

```sh
# Single node, no auth
FLEXDB_NODES=http://localhost:4001 npm run test:integration

# Multiple nodes with auth token
FLEXDB_NODES=http://a:4001,http://b:4001 FLEXDB_TOKEN=mytoken npm run test:integration
```

## Building

```sh
npm run build        # compiles src/ → dist/
npm run typecheck    # type-check without emitting
```

## Publishing to npm

```sh
# Dry run — inspect what will be included
npm pack --dry-run

# Publish
npm publish
```

`prepublishOnly` runs `build` + `typecheck` automatically.
Only `dist/` and `README.md` are included in the published package.

## License

MIT
