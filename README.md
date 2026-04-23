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
```

#### The `consistency` parameter

Consistency is primarily configured **per table** via `db.setTableMode()` — that is where you set the routing behaviour for all queries against a table. Most callers never need the `consistency` argument on `query()`.

The optional second argument is a **per-request routing hint** that overrides the table's mode for that one call:

| Table mode | Hint `"raft"` | Hint `"eventual"` |
|------------|---------------|-------------------|
| `raft`     | no-op         | read from any node (potentially stale) |
| `eventual` | read from leader (fresh) | no-op |
| `crdt`     | read from leader (fresh) | no-op |

**When you'd use it:** after writing something critical on an `eventual` or `crdt` table, force a single read through the leader to confirm it committed:

```ts
await db.execute({ sql: "INSERT INTO jobs (task) VALUES (?1)", params: ["deploy"] });

// Force leader read for this one query
const { results } = await db.query(
  { sql: "SELECT id FROM jobs WHERE task = ?1", params: ["deploy"] },
  "raft",
);
```

#### Query response telemetry

Every `QueryResponse` includes observability fields alongside `results`:

| Field | Type | Description |
|-------|------|-------------|
| `node_id` | `string` | ID of the node that received the request |
| `role` | `"leader" \| "follower" \| "standalone"` | Role of the receiving node at request time |
| `executed_on` | `string` | ID of the node where SQL actually ran — differs from `node_id` when the request was forwarded to the leader |
| `raft_index` | `number` | Committed RAFT log index after this write (0 for reads / standalone) |
| `crdt_conflicts` | `unknown[]` | Conflict records for CRDT tables (non-empty only when two nodes wrote the same key concurrently) |

`executed_on === node_id` for `raft` writes (leader executed), `crdt` writes (always local), and all reads.
`executed_on !== node_id` when a follower forwards an `eventual` or `raft`-mode write to the leader.

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

**Recommended — `transaction(fn)` wrapper** (auto commit/rollback):

```ts
const result = await db.transaction(async (tx) => {
  await tx.execute({ sql: "UPDATE accounts SET balance = balance - ?1 WHERE id = ?2", params: [100, 1] });
  await tx.execute({ sql: "UPDATE accounts SET balance = balance + ?1 WHERE id = ?2", params: [100, 2] });
  return "transferred";
});
// commits on success, rolls back and re-throws on any error
```

**Manual handle** (for explicit control):

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
await db.health();    // { status: "ok" }
await db.getStatus(); // node role, raft index, active transactions, …
await db.getNodes();  // all cluster nodes
await db.metrics();   // raw Prometheus text
```

### Analytics (requires FlexDB analytics feature)

```ts
await db.listAnalytics();
await db.getAnalyticsTable("daily_sales");
await db.rebuildAnalyticsTable("daily_sales");
```

---

## Honker — queues, streams, locks, and scheduler

Honker is an optional server feature that adds work queues, durable event streams,
distributed locks, rate limiting, ephemeral notifications, and a cron scheduler —
all stored in the same SQLite file as your application data, replicated over RAFT.

It must be compiled into the server with `--features honker`. All routes always
exist; when the feature is absent they return `503` and the SDK throws
`FlexDBHonkerUnavailableError`. Check availability before use:

```ts
const { available } = await db.honker.status();
if (!available) {
  console.warn("honker not enabled on this cluster");
}
```

### Work queues

```ts
const q = db.honker.queue("email");

// Enqueue a job
const { job_id } = await q.enqueue(
  { to: "user@example.com", subject: "Hello" },
  { priority: 1, delay_s: 0, expires_s: 3600 },
);

// Claim a batch (worker side)
const { jobs } = await q.claim({ worker_id: "w-1", batch_size: 10, visibility_s: 300 });
for (const job of jobs) {
  // process job.payload …
}

// Acknowledge completed jobs
await q.ack([42, 43], "w-1");

// Retry with backoff
await q.retry(42, "w-1", { delay_s: 30, error: "smtp timeout" });

// Permanently dead-letter
await q.fail(42, "w-1", "unrecoverable");

// Queue depth
const { pending, processing, dead } = await q.stats();

// Sweep expired jobs
await q.sweepExpired();
```

### Durable streams

Append-only logs with per-consumer offset tracking. Consumers can replay from
any checkpoint.

```ts
const stream = db.honker.stream("events");

// Publish
const { event_id } = await stream.publish({ user_id: 42, action: "login" });

// Read from an offset (optionally auto-advance the consumer cursor)
const events = await stream.read({ consumer: "dashboard", since: 0, save: true });
// events: [{ id, payload, created_at }, …]

// Manually manage the offset
await stream.saveOffset("dashboard", 7);
const { offset } = await stream.getOffset("dashboard");
```

### Ephemeral notifications

Fire-and-forget channel messages. Not stored durably — use streams when replay
is needed.

```ts
const notif = db.honker.notification("orders");

// Fire
await notif.fire({ order_id: 123 });

// Poll for new messages since a rowid
const items = await notif.poll({ since: 0, limit: 50 });
// items: [{ rowid, payload, created_at }, …]

// Stream in real time via SSE (async generator, Node 18+)
const ac = new AbortController();
for await (const item of notif.subscribe(ac.signal)) {
  console.log(item.payload);
  // call ac.abort() to stop
}

// Prune old notifications
await notif.prune();
```

### Distributed locks

Named TTL-based mutual exclusion. A crashed holder is evicted automatically
after the TTL — no manual cleanup needed.

```ts
const lock = db.honker.lock("migration");

const { acquired } = await lock.acquire({ ttl_s: 60 });
if (acquired) {
  try {
    // do the work …
  } finally {
    await lock.release();
  }
}
```

### Rate limiting

Token-bucket limiter stored in SQLite. Useful for per-key, per-IP, or
per-resource limits.

```ts
const rl = db.honker.rateLimit("api-key-abc");

const { allowed, remaining, retry_after_s } = await rl.check({
  limit: 100,
  per_s: 60,
});

if (!allowed) {
  console.log(`rate limited, retry in ${retry_after_s}s`);
}

// Sweep stale buckets periodically
await rl.sweep();
```

### Scheduler

Register cron handlers tied to queues. A scheduler tick enqueues any jobs
whose cron time has passed. The built-in server worker drives this
automatically when Honker is active.

```ts
const sched = db.honker.scheduler;

// Register
await sched.register({
  queue: "email",
  handler_name: "daily-digest",
  cron_expr: "0 3 * * *",
});

// List
const { handlers } = await sched.list();

// Manual tick (enqueues overdue jobs)
const { jobs_enqueued } = await sched.tick("scheduler-0");

// Time until next job
const { next_ts, handler_name } = await sched.next();

// Unregister
await sched.unregister("daily-digest");
```

### Job results

Workers can store structured results keyed by job ID for the enqueuer to retrieve.

```ts
const jobs = db.honker.jobs;

// Worker: store result after processing
await jobs.storeResult(42, { sent_at: Date.now() }, /* ttl_s */ 3600);

// Enqueuer: retrieve the outcome
const result = await jobs.getResult(42);

// Maintenance: sweep expired results
await jobs.sweepResults();
```

### Transactional enqueue

Honker's headline feature: enqueue a job and write business data in the same
RAFT transaction — either both commit or neither does.

```ts
await db.transaction(async (tx) => {
  await tx.execute({
    sql: "INSERT INTO orders (id, item, price) VALUES (?1, ?2, ?3)",
    params: [99, "widget", 29.99],
  });
  // enqueued into the same transaction — rolls back with the INSERT if it fails
  await tx.enqueue("fulfillment", { order_id: 99 });
});
```

---

## Error types

```ts
import {
  FlexDBError,
  FlexDBAuthError,
  FlexDBHonkerUnavailableError,
  FlexDBNoLeaderError,
  FlexDBTransactionError,
  FlexDBNoHealthyNodeError,
  FlexDBTimeoutError,
} from "flexdb-node";

try {
  await db.query({ sql: "SELECT 1" });
} catch (err) {
  if (err instanceof FlexDBAuthError)              console.error("check your auth token");
  if (err instanceof FlexDBHonkerUnavailableError) console.error("honker not enabled on server");
  if (err instanceof FlexDBNoLeaderError)          console.error("cluster is electing a leader");
  if (err instanceof FlexDBNoHealthyNodeError)     console.error("all nodes are unreachable");
  if (err instanceof FlexDBTimeoutError)           console.error("request timed out");
  if (err instanceof FlexDBTransactionError)       console.error("transaction error:", err.message);
  if (err instanceof FlexDBError)                  console.error(err.statusCode, err.message);
}
```

| Class | Status | When thrown |
|-------|--------|-------------|
| `FlexDBAuthError` | 401 | Invalid or missing auth token |
| `FlexDBHonkerUnavailableError` | 503 | Server not compiled with `--features honker`, or extension failed to load |
| `FlexDBNoLeaderError` | 503 | RAFT cluster has no elected leader |
| `FlexDBTransactionError` | 404/409/410 | Transaction not found, conflicted, or expired |
| `FlexDBNoHealthyNodeError` | — | All configured nodes are unreachable |
| `FlexDBTimeoutError` | — | Request exceeded `timeoutMs` |
| `FlexDBError` | any | Base class — catch-all for unexpected status codes |

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
