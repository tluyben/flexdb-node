import type { EnqueueOptions, EnqueueResponse } from "./honker.js";
export type { EnqueueOptions, EnqueueResponse };

// ─── Request / Response types ────────────────────────────────────────────────

export interface Statement {
  sql: string;
  params?: (string | number | boolean | null)[];
}

export type ConsistencyMode = "raft" | "eventual";
export type TableMode = "raft" | "eventual" | "crdt";
export type CrdtStrategy = "lww" | "lww_column";

export interface QueryRequest {
  statements: Statement[];
  consistency?: ConsistencyMode;
}

export interface StatementResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  rows_affected: number;
  last_insert_id: number | null;
  time_ns: number;
}

export interface QueryResponse {
  results: StatementResult[];
  node_id: string;
  /** Role of the node that received the request: "leader", "follower", or "standalone". */
  role: "leader" | "follower" | "standalone";
  /** Node ID of the node that actually executed the SQL (differs from node_id when forwarded to leader). */
  executed_on: string;
  raft_index: number;
  crdt_conflicts: unknown[];
}

export interface TransactionBeginResponse {
  transaction_id: string;
  expires_at: string;
}

export interface TransactionCommitResponse {
  status: "committed";
  transaction_id: string;
  raft_index: number;
}

export interface TransactionRollbackResponse {
  status: "rolled_back";
  transaction_id: string;
}

export interface TableModeResponse {
  table: string;
  mode: TableMode;
  crdt_strategy?: CrdtStrategy;
}

export interface TableSearchConfig {
  table: string;
  columns: string[];
}

export interface SearchRequest {
  table: string;
  query: string;
  limit?: number;
}

export interface SearchResponse {
  results: StatementResult;
  node_id: string;
}

export interface NodeInfo {
  node_id: string;
  raft_id: number;
  raft_addr: string;
  http_addr: string;
}

export interface NodesResponse {
  nodes: NodeInfo[];
}

export interface StatusResponse {
  node_id: string;
  role: "leader" | "follower" | "candidate" | "learner" | "shutdown";
  leader_id: string | null;
  current_term: number;
  last_log_index: number;
  replication_lag: number;
  active_transactions: number;
  version: string;
}

export interface HealthResponse {
  status: "ok";
}

export interface AnalyticalTable {
  name: string;
  select_sql: string;
  source_tables: string[];
  node_count: number;
  interval_secs: number;
  assigned_nodes: string[];
  last_built_at: string | null;
  last_build_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface AnalyticsListResponse {
  tables: AnalyticalTable[];
}

export interface AnalyticsGetResponse {
  table: AnalyticalTable;
}

export interface AnalyticsRebuildResponse {
  table: string;
  rows_loaded: number;
  time_ms: number;
}

// ─── Client config ────────────────────────────────────────────────────────────

export interface FlexDBClientOptions {
  /**
   * One or more FlexDB node URLs, e.g. ["http://localhost:4001"].
   * Multiple nodes are used in round-robin with health checks.
   */
  nodes: string | string[];

  /** Bearer auth token — omit if auth is disabled on the server. */
  authToken?: string;

  /**
   * How often (ms) to background-health-check nodes when multiple are
   * configured. Default: 10_000 ms.
   */
  healthCheckIntervalMs?: number;

  /**
   * Request timeout in ms. Default: 30_000 ms.
   */
  timeoutMs?: number;
}

// ─── Transaction handle ───────────────────────────────────────────────────────

export interface TransactionHandle {
  readonly id: string;
  readonly expiresAt: Date;
  /** Execute statements inside this transaction (stages them server-side). */
  query(statements: Statement[], consistency?: ConsistencyMode): Promise<QueryResponse>;
  execute(statements: Statement[]): Promise<QueryResponse>;
  commit(): Promise<TransactionCommitResponse>;
  rollback(): Promise<TransactionRollbackResponse>;
  /** Enqueue a honker job atomically within this transaction. */
  enqueue(queue: string, payload: unknown, options?: EnqueueOptions): Promise<EnqueueResponse>;
}
