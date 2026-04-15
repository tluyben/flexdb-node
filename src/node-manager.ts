import { FlexDBNoHealthyNodeError } from "./errors.js";

export interface ManagedNode {
  url: string;
  healthy: boolean;
  lastChecked: number;
  consecutiveFailures: number;
}

/**
 * Manages one or more FlexDB nodes.
 * - Single node: always uses that node.
 * - Multiple nodes: round-robin over healthy nodes, background health checks.
 */
export class NodeManager {
  private readonly nodes: ManagedNode[];
  private cursor = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly authHeader: string | undefined;

  constructor(
    urls: string[],
    intervalMs: number,
    timeoutMs: number,
    authToken?: string,
  ) {
    if (urls.length === 0) throw new Error("At least one FlexDB node URL is required");
    this.nodes = urls.map((url) => ({
      url: url.replace(/\/$/, ""),
      healthy: true,
      lastChecked: 0,
      consecutiveFailures: 0,
    }));
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.authHeader = authToken ? `Bearer ${authToken}` : undefined;

    if (urls.length > 1) {
      this.startHealthChecks();
    }
  }

  /** Pick the next healthy node (round-robin). */
  next(): ManagedNode {
    const healthy = this.nodes.filter((n) => n.healthy);
    if (healthy.length === 0) {
      // All nodes are marked unhealthy — optimistically try them all anyway
      // (cluster may have recovered since last check)
      this.nodes.forEach((n) => {
        n.healthy = true;
        n.consecutiveFailures = 0;
      });
      return this.nodes[this.cursor % this.nodes.length];
    }
    const node = healthy[this.cursor % healthy.length];
    this.cursor = (this.cursor + 1) % healthy.length;
    return node;
  }

  /** Mark a node as failed after a request error. */
  markFailed(url: string): void {
    const node = this.nodes.find((n) => n.url === url);
    if (node) {
      node.consecutiveFailures += 1;
      if (node.consecutiveFailures >= 2) {
        node.healthy = false;
      }
    }
  }

  /** Mark a node as healthy after a successful request. */
  markHealthy(url: string): void {
    const node = this.nodes.find((n) => n.url === url);
    if (node) {
      node.healthy = true;
      node.consecutiveFailures = 0;
    }
  }

  /** Returns a snapshot of all node states. */
  getNodes(): ReadonlyArray<Readonly<ManagedNode>> {
    return this.nodes;
  }

  /** Stop background health checks and release resources. */
  destroy(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private startHealthChecks(): void {
    this.healthTimer = setInterval(() => {
      void this.checkAll();
    }, this.intervalMs);
    // Don't block process exit
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  private async checkAll(): Promise<void> {
    await Promise.allSettled(this.nodes.map((n) => this.checkOne(n)));
  }

  private async checkOne(node: ManagedNode): Promise<void> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const headers: Record<string, string> = {};
      if (this.authHeader) headers["Authorization"] = this.authHeader;

      const res = await fetch(`${node.url}/v1/health`, {
        signal: controller.signal,
        headers,
      });
      clearTimeout(timer);

      if (res.ok) {
        this.markHealthy(node.url);
      } else {
        this.markFailed(node.url);
      }
    } catch {
      this.markFailed(node.url);
    }
    node.lastChecked = Date.now();
  }
}
