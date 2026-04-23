import {
  FlexDBAuthError,
  FlexDBError,
  FlexDBHonkerUnavailableError,
  FlexDBNoHealthyNodeError,
  FlexDBNoLeaderError,
  FlexDBTimeoutError,
  FlexDBTransactionError,
} from "./errors.js";
import { HonkerClient, type HonkerRequester } from "./honker.js";
import { BranchesClient, type BranchesRequester } from "./branches.js";
import { NodeManager } from "./node-manager.js";
import { loadClusterFile } from "./cluster-file.js";
import type {
  AnalyticsGetResponse,
  AnalyticsListResponse,
  AnalyticsRebuildResponse,
  ChangeEntry,
  ClientTokenRequest,
  ClientTokenResponse,
  ConsistencyMode,
  CrdtStrategy,
  EnqueueOptions,
  EnqueueResponse,
  FlexDBClientOptions,
  HealthResponse,
  ImportDatabaseResponse,
  JoinNodeRequest,
  JoinNodeResponse,
  NodesResponse,
  QueryRequest,
  QueryResponse,
  RejectedEntry,
  RemoveNodeResponse,
  RestoreResponse,
  SearchRequest,
  SearchResponse,
  Statement,
  StatusResponse,
  SyncRequest,
  SyncResponse,
  SyncStatusResponse,
  TableMode,
  TableModeResponse,
  TableSearchConfig,
  TransactionBeginResponse,
  TransactionCommitResponse,
  TransactionHandle,
  TransactionRollbackResponse,
  WipeNodeResponse,
  WipeSelfResponse,
} from "./types.js";

const DEFAULT_HEALTH_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class FlexDBClient {
  private readonly manager: NodeManager;
  private readonly authToken?: string;
  private readonly timeoutMs: number;
  private _honker?: HonkerClient;
  private _branches?: BranchesClient;

  /**
   * Create a FlexDBClient from a `.flexdb-cluster` file.
   *
   * With no arguments, walks up from `process.cwd()` to find the file.
   * Pass an explicit path to override.
   *
   * All node `http_url` values are used in round-robin.
   * The `auth_token` from the file is used unless overridden in `overrides`.
   */
  static fromClusterFile(
    filePath?: string,
    overrides?: Partial<Omit<FlexDBClientOptions, "nodes" | "authToken">>,
  ): FlexDBClient {
    const cluster = loadClusterFile(filePath);
    return new FlexDBClient({
      nodes: cluster.nodes.map((n) => n.http_url),
      authToken: cluster.auth_token || undefined,
      ...overrides,
    });
  }

  constructor(options: FlexDBClientOptions) {
    const urls = Array.isArray(options.nodes) ? options.nodes : [options.nodes];
    this.authToken = options.authToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.manager = new NodeManager(
      urls,
      options.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
      this.timeoutMs,
      options.authToken,
    );
  }

  // ─── Core query / execute ──────────────────────────────────────────────────

  /**
   * Execute one or more SQL statements (reads or writes).
   */
  async query(
    statements: Statement | Statement[],
    consistency?: ConsistencyMode,
  ): Promise<QueryResponse> {
    const body: QueryRequest = {
      statements: Array.isArray(statements) ? statements : [statements],
      ...(consistency ? { consistency } : {}),
    };
    return this.post<QueryResponse>("/v1/query", body);
  }

  /**
   * Execute one or more write-only SQL statements (SELECT is rejected by the server).
   */
  async execute(statements: Statement | Statement[]): Promise<QueryResponse> {
    const body: QueryRequest = {
      statements: Array.isArray(statements) ? statements : [statements],
    };
    return this.post<QueryResponse>("/v1/execute", body);
  }

  // ─── Transactions ──────────────────────────────────────────────────────────

  /**
   * Open a new transaction and return a handle.
   * The handle exposes query(), execute(), commit(), and rollback().
   * Only tables in "raft" mode support transactions.
   *
   * Prefer `transaction(fn)` for the automatic commit/rollback wrapper.
   */
  async beginTransaction(): Promise<TransactionHandle> {
    const res = await this.post<TransactionBeginResponse>("/v1/transaction/begin", {});
    return this.buildHandle(res.transaction_id, new Date(res.expires_at));
  }

  /**
   * Run `fn` inside a transaction, committing on success and rolling back on
   * any thrown error. The resolved value of `fn` is returned.
   *
   * ```ts
   * const result = await db.transaction(async (tx) => {
   *   await tx.execute({ sql: "UPDATE accounts SET balance = balance - ?1 WHERE id = ?2", params: [100, 1] });
   *   await tx.execute({ sql: "UPDATE accounts SET balance = balance + ?1 WHERE id = ?2", params: [100, 2] });
   *   return "transferred";
   * });
   * ```
   */
  async transaction<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T> {
    const tx = await this.beginTransaction();
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // Ignore rollback errors (e.g. already expired) — surface original error
      }
      throw err;
    }
  }

  private buildHandle(id: string, expiresAt: Date): TransactionHandle {
    const self = this;
    const txHeader = { "X-Transaction-ID": id };

    return {
      id,
      expiresAt,

      async query(
        statements: Statement | Statement[],
        consistency?: ConsistencyMode,
      ): Promise<QueryResponse> {
        const body: QueryRequest = {
          statements: Array.isArray(statements) ? statements : [statements],
          ...(consistency ? { consistency } : {}),
        };
        return self.post<QueryResponse>("/v1/query", body, txHeader);
      },

      async execute(statements: Statement | Statement[]): Promise<QueryResponse> {
        const body: QueryRequest = {
          statements: Array.isArray(statements) ? statements : [statements],
        };
        return self.post<QueryResponse>("/v1/execute", body, txHeader);
      },

      async commit(): Promise<TransactionCommitResponse> {
        return self.post<TransactionCommitResponse>(
          "/v1/transaction/commit",
          { transaction_id: id },
          txHeader,
        );
      },

      async rollback(): Promise<TransactionRollbackResponse> {
        return self.post<TransactionRollbackResponse>(
          "/v1/transaction/rollback",
          { transaction_id: id },
          txHeader,
        );
      },

      async enqueue(
        queue: string,
        payload: unknown,
        options?: EnqueueOptions,
      ): Promise<EnqueueResponse> {
        return self.post<EnqueueResponse>(
          `/v1/queues/${encodeURIComponent(queue)}`,
          { payload, ...options },
          txHeader,
        );
      },
    };
  }

  // ─── Table mode ────────────────────────────────────────────────────────────

  /** Get the consistency mode for a table. */
  async getTableMode(table: string): Promise<TableModeResponse> {
    return this.get<TableModeResponse>(`/v1/table/${encodeURIComponent(table)}/mode`);
  }

  /** Set the consistency mode for a table. */
  async setTableMode(
    table: string,
    mode: TableMode,
    crdtStrategy?: CrdtStrategy,
  ): Promise<TableModeResponse> {
    const body: { mode: TableMode; crdt_strategy?: CrdtStrategy } = { mode };
    if (crdtStrategy) body.crdt_strategy = crdtStrategy;
    return this.put<TableModeResponse>(
      `/v1/table/${encodeURIComponent(table)}/mode`,
      body,
    );
  }

  // ─── Full-text search ──────────────────────────────────────────────────────

  /** Get the full-text search configuration for a table. */
  async getSearchConfig(table: string): Promise<TableSearchConfig> {
    return this.get<TableSearchConfig>(
      `/v1/table/${encodeURIComponent(table)}/search`,
    );
  }

  /** Enable full-text search on the specified columns. */
  async enableSearch(table: string, columns: string[]): Promise<TableSearchConfig> {
    return this.put<TableSearchConfig>(
      `/v1/table/${encodeURIComponent(table)}/search`,
      { columns },
    );
  }

  /** Disable full-text search on a table. */
  async disableSearch(table: string): Promise<TableSearchConfig> {
    return this.delete<TableSearchConfig>(
      `/v1/table/${encodeURIComponent(table)}/search`,
    );
  }

  /** Execute a full-text search query. */
  async search(req: SearchRequest): Promise<SearchResponse> {
    return this.post<SearchResponse>("/v1/search", req);
  }

  // ─── Cluster / observability ───────────────────────────────────────────────

  /** List all nodes in the cluster. */
  async getNodes(): Promise<NodesResponse> {
    return this.get<NodesResponse>("/v1/nodes");
  }

  /** Get the status of the node that handles the request. */
  async getStatus(): Promise<StatusResponse> {
    return this.get<StatusResponse>("/v1/status");
  }

  /** Liveness probe — always returns { status: "ok" } if reachable. */
  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/v1/health");
  }

  /** Fetch raw Prometheus-format metrics text. */
  async metrics(): Promise<string> {
    return this.getRaw("/v1/metrics");
  }

  // ─── Analytics ────────────────────────────────────────────────────────────

  /** List all analytical tables. */
  async listAnalytics(): Promise<AnalyticsListResponse> {
    return this.get<AnalyticsListResponse>("/v1/analytics");
  }

  /** Get a single analytical table definition. */
  async getAnalyticsTable(name: string): Promise<AnalyticsGetResponse> {
    return this.get<AnalyticsGetResponse>(`/v1/analytics/${encodeURIComponent(name)}`);
  }

  /** Trigger an immediate local rebuild of an analytical table. */
  async rebuildAnalyticsTable(name: string): Promise<AnalyticsRebuildResponse> {
    return this.post<AnalyticsRebuildResponse>(
      `/v1/analytics/${encodeURIComponent(name)}/rebuild`,
      {},
    );
  }

  // ─── Backup / restore / import ────────────────────────────────────────────

  /**
   * Download a zstd-compressed snapshot of the database.
   * Pass an age X25519 public key (`age1...`) to receive an age-encrypted blob
   * instead — the server discards plaintext after the request completes.
   */
  async backup(publicKey?: string): Promise<Uint8Array> {
    const path = publicKey
      ? `/v1/backup?public_key=${encodeURIComponent(publicKey)}`
      : "/v1/backup";
    return this.getBytes(path);
  }

  /**
   * Restore the database from a zstd-compressed snapshot (the raw output of
   * `backup()`, after decrypting if it was encrypted).
   * **Destructive** — all existing data is overwritten.
   */
  restore(data: Uint8Array | ArrayBuffer): Promise<RestoreResponse> {
    return this.postBinary<RestoreResponse>("/v1/restore", data);
  }

  /**
   * Import a plain (uncompressed) SQLite database file, registering all user
   * tables with the given default consistency mode (default: `"raft"`).
   * Must be called on the RAFT leader in a multi-node cluster.
   */
  importDatabase(
    data: Uint8Array | ArrayBuffer,
    mode?: "raft" | "eventual" | "crdt",
  ): Promise<ImportDatabaseResponse> {
    return this.postBinary<ImportDatabaseResponse>(
      "/v1/import",
      data,
      mode ? { mode } : undefined,
    );
  }

  // ─── Cluster administration ────────────────────────────────────────────────

  /** Add a new node to the RAFT cluster as a learner, then promote to voter. */
  joinNode(req: JoinNodeRequest): Promise<JoinNodeResponse> {
    return this.post<JoinNodeResponse>("/v1/nodes/join", req);
  }

  /** Remove a node from the RAFT voter set and the node registry. */
  removeNode(nodeId: string): Promise<RemoveNodeResponse> {
    return this.delete<RemoveNodeResponse>(`/v1/nodes/${encodeURIComponent(nodeId)}`);
  }

  /**
   * Remove a node from the cluster, instruct it to wipe its data and restart,
   * then re-add it once it comes back up. Useful for resetting a diverged peer.
   */
  wipeNode(nodeId: string): Promise<WipeNodeResponse> {
    return this.post<WipeNodeResponse>(
      `/v1/nodes/${encodeURIComponent(nodeId)}/wipe`,
      {},
    );
  }

  /**
   * Instruct this node to delete its databases and exit (systemd restarts it
   * clean). Only valid on non-leader nodes.
   */
  wipeSelf(): Promise<WipeSelfResponse> {
    return this.post<WipeSelfResponse>("/v1/admin/wipe", {});
  }

  // ─── Client tokens and sync ────────────────────────────────────────────────

  /**
   * Issue a short-lived JWT for a mobile/browser client, scoped to a list of
   * CRDT tables. The token is used as the Bearer credential on `sync()` calls.
   */
  issueClientToken(req: ClientTokenRequest): Promise<ClientTokenResponse> {
    return this.post<ClientTokenResponse>("/v1/client-token", req);
  }

  /**
   * Execute a sync operation on behalf of a mobile/browser client.
   * `clientToken` is the JWT returned by `issueClientToken()` — it replaces
   * the server auth token for this request (the sync endpoint uses client JWT
   * auth, not server bearer auth).
   */
  sync(req: SyncRequest, clientToken: string): Promise<SyncResponse> {
    return this.post<SyncResponse>("/v1/sync", req, {
      Authorization: `Bearer ${clientToken}`,
    });
  }

  /** Check whether the sync endpoint is reachable. */
  syncStatus(): Promise<SyncStatusResponse> {
    return this.get<SyncStatusResponse>("/v1/sync/status");
  }

  // ─── Branches ─────────────────────────────────────────────────────────────

  /**
   * Access branching operations: list, create, get, delete, rename, and switch.
   * Requires the server to be started with `FEATURE_BRANCHING=true`; operations
   * return a 400 error otherwise.
   */
  get branches(): BranchesClient {
    if (!this._branches) {
      const req: BranchesRequester = {
        post: (path, body, headers) => this.post(path, body, headers),
        get: (path) => this.get(path),
        delete: (path) => this.delete(path),
        patch: (path, body) => this.patch(path, body),
      };
      this._branches = new BranchesClient(req);
    }
    return this._branches;
  }

  // ─── Honker ───────────────────────────────────────────────────────────────

  /**
   * Access Honker features: queues, streams, notifications, locks, rate limits,
   * and the scheduler. All methods throw `FlexDBHonkerUnavailableError` when the
   * server was not compiled with `--features honker` or the extension failed to load.
   *
   * Check availability without throwing via `db.honker.status()`.
   */
  get honker(): HonkerClient {
    if (!this._honker) {
      const req: HonkerRequester = {
        post: (path, body, headers) => this.post(path, body, headers),
        get: (path) => this.get(path),
        put: (path, body) => this.put(path, body),
        delete: (path) => this.delete(path),
        rawFetch: (path, signal) => this.rawFetch(path, signal),
      };
      this._honker = new HonkerClient(req);
    }
    return this._honker;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Stop background health checks. Call this when you're done with the client
   * to allow the process to exit cleanly.
   */
  destroy(): void {
    this.manager.destroy();
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  private baseHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) h["Authorization"] = `Bearer ${this.authToken}`;
    if (extra) Object.assign(h, extra);
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const node = this.manager.next();
    const url = `${node.url}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.baseHeaders(extraHeaders),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      this.manager.markFailed(node.url);
      if (err instanceof Error && err.name === "AbortError") {
        throw new FlexDBTimeoutError(url, this.timeoutMs);
      }
      throw new FlexDBNoHealthyNodeError();
    }

    clearTimeout(timer);

    if (res.ok) {
      this.manager.markHealthy(node.url);
      return res.json() as Promise<T>;
    }

    // Parse error body
    let errBody: { error?: string; code?: number } = {};
    try {
      errBody = (await res.json()) as { error?: string; code?: number };
    } catch {
      /* ignore parse failure */
    }

    const message = errBody.error ?? res.statusText;

    switch (res.status) {
      case 401:
        throw new FlexDBAuthError(node.url);
      case 503:
        if (message.includes("honker")) {
          throw new FlexDBHonkerUnavailableError(node.url, message);
        }
        throw new FlexDBNoLeaderError(node.url);
      case 404:
      case 409:
      case 410:
        throw new FlexDBTransactionError(message, res.status, node.url);
      default:
        throw new FlexDBError(message, res.status, node.url);
    }
  }

  private post<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>("POST", path, body, extraHeaders);
  }

  private get<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, undefined, extraHeaders);
  }

  private put<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>("PUT", path, body, extraHeaders);
  }

  private delete<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
    return this.request<T>("DELETE", path, undefined, extraHeaders);
  }

  private patch<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>("PATCH", path, body, extraHeaders);
  }

  private async getBytes(path: string): Promise<Uint8Array> {
    const node = this.manager.next();
    const url = `${node.url}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {};
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;

    let res: Response;
    try {
      res = await fetch(url, { headers, signal: controller.signal });
    } catch (err: unknown) {
      clearTimeout(timer);
      this.manager.markFailed(node.url);
      if (err instanceof Error && err.name === "AbortError") {
        throw new FlexDBTimeoutError(url, this.timeoutMs);
      }
      throw new FlexDBNoHealthyNodeError();
    }
    clearTimeout(timer);

    if (res.ok) {
      this.manager.markHealthy(node.url);
      return new Uint8Array(await res.arrayBuffer());
    }

    let errBody: { error?: string } = {};
    try { errBody = (await res.json()) as { error?: string }; } catch { /* ignore */ }
    const message = errBody.error ?? res.statusText;
    switch (res.status) {
      case 401: throw new FlexDBAuthError(node.url);
      case 503: throw new FlexDBNoLeaderError(node.url);
      default: throw new FlexDBError(message, res.status, node.url);
    }
  }

  private async postBinary<T>(
    path: string,
    data: Uint8Array | ArrayBuffer,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const node = this.manager.next();
    const qs = queryParams
      ? "?" + new URLSearchParams(queryParams).toString()
      : "";
    const url = `${node.url}${path}${qs}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: data instanceof ArrayBuffer ? new Uint8Array(data) : data,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      this.manager.markFailed(node.url);
      if (err instanceof Error && err.name === "AbortError") {
        throw new FlexDBTimeoutError(url, this.timeoutMs);
      }
      throw new FlexDBNoHealthyNodeError();
    }
    clearTimeout(timer);

    if (res.ok) {
      this.manager.markHealthy(node.url);
      return res.json() as Promise<T>;
    }

    let errBody: { error?: string; code?: number } = {};
    try { errBody = (await res.json()) as { error?: string; code?: number }; } catch { /* ignore */ }
    const message = errBody.error ?? res.statusText;
    switch (res.status) {
      case 401: throw new FlexDBAuthError(node.url);
      case 503: throw new FlexDBNoLeaderError(node.url);
      default: throw new FlexDBError(message, res.status, node.url);
    }
  }

  private async getRaw(path: string): Promise<string> {
    const node = this.manager.next();
    const url = `${node.url}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {};
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;

    let res: Response;
    try {
      res = await fetch(url, { headers, signal: controller.signal });
    } catch (err: unknown) {
      clearTimeout(timer);
      this.manager.markFailed(node.url);
      if (err instanceof Error && err.name === "AbortError") {
        throw new FlexDBTimeoutError(url, this.timeoutMs);
      }
      throw new FlexDBNoHealthyNodeError();
    }
    clearTimeout(timer);

    if (!res.ok) {
      throw new FlexDBError(res.statusText, res.status, node.url);
    }
    this.manager.markHealthy(node.url);
    return res.text();
  }

  // Used by HonkerNotification.subscribe() for the SSE endpoint.
  private async rawFetch(path: string, signal?: AbortSignal): Promise<Response> {
    const node = this.manager.next();
    const url = `${node.url}${path}`;
    const headers: Record<string, string> = {};
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;

    let res: Response;
    try {
      res = await fetch(url, { headers, signal });
    } catch (err: unknown) {
      this.manager.markFailed(node.url);
      if (err instanceof Error && err.name === "AbortError") {
        throw new FlexDBTimeoutError(url, this.timeoutMs);
      }
      throw new FlexDBNoHealthyNodeError();
    }

    if (!res.ok) {
      let errBody: { error?: string } = {};
      try {
        errBody = (await res.json()) as { error?: string };
      } catch { /* ignore */ }
      const message = errBody.error ?? res.statusText;
      if (res.status === 503) {
        if (message.includes("honker")) {
          throw new FlexDBHonkerUnavailableError(node.url, message);
        }
        throw new FlexDBNoLeaderError(node.url);
      }
      throw new FlexDBError(message, res.status, node.url);
    }

    this.manager.markHealthy(node.url);
    return res;
  }
}
