// ─── Types ────────────────────────────────────────────────────────────────────

export interface HonkerStatusResponse {
  available: boolean;
  bootstrapped: boolean;
  bootstrapped_at: string | null;
}

export interface EnqueueOptions {
  priority?: number;
  delay_s?: number;
  expires_s?: number;
}

export interface EnqueueResponse {
  job_id: number;
}

export interface ClaimOptions {
  worker_id: string;
  batch_size?: number;
  visibility_s?: number;
}

export interface JobItem {
  id: number;
  payload: unknown;
  attempt: number;
}

export interface RetryOptions {
  delay_s?: number;
  error?: string;
}

export interface QueueStats {
  pending: number;
  processing: number;
  dead: number;
}

export interface StreamEvent {
  id: number;
  payload: unknown;
  created_at: string;
}

export interface ReadEventsOptions {
  consumer?: string;
  since?: number;
  save?: boolean;
}

export interface OffsetResponse {
  consumer: string;
  offset: number;
}

export interface NotificationItem {
  rowid: number;
  payload: unknown;
  created_at: string;
}

export interface PollOptions {
  since?: number;
  limit?: number;
}

export interface RateLimitOptions {
  limit: number;
  per_s: number;
}

export interface RateLimitResponse {
  allowed: boolean;
  remaining: number;
  retry_after_s?: number | null;
}

export interface RegisterHandlerOptions {
  queue: string;
  handler_name: string;
  cron_expr: string;
}

export interface SchedulerHandler {
  handler_name: string;
  queue: string;
  cron_expr: string;
  created_at: string;
}

export interface SchedulerNextResponse {
  next_ts: string;
  handler_name: string;
}

// ─── Internal HTTP interface ──────────────────────────────────────────────────

export interface HonkerRequester {
  post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  get<T>(path: string): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  rawFetch(path: string, signal?: AbortSignal): Promise<Response>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

function qs(params: URLSearchParams): string {
  const s = params.toString();
  return s ? `?${s}` : "";
}

// ─── Work Queue ───────────────────────────────────────────────────────────────

export class HonkerQueue {
  constructor(
    private readonly name: string,
    private readonly req: HonkerRequester,
  ) {}

  enqueue(payload: unknown, options?: EnqueueOptions): Promise<EnqueueResponse> {
    return this.req.post<EnqueueResponse>(`/v1/queues/${enc(this.name)}`, {
      payload,
      ...options,
    });
  }

  claim(options: ClaimOptions): Promise<{ jobs: JobItem[] }> {
    return this.req.post<{ jobs: JobItem[] }>(
      `/v1/queues/${enc(this.name)}/claim`,
      options,
    );
  }

  ack(job_ids: number[], worker_id: string): Promise<{ acked: number }> {
    return this.req.post<{ acked: number }>(
      `/v1/queues/${enc(this.name)}/ack`,
      { job_ids, worker_id },
    );
  }

  retry(job_id: number, worker_id: string, options?: RetryOptions): Promise<{ ok: boolean }> {
    return this.req.post<{ ok: boolean }>(`/v1/queues/${enc(this.name)}/retry`, {
      job_id,
      worker_id,
      ...options,
    });
  }

  fail(job_id: number, worker_id: string, error?: string): Promise<{ ok: boolean }> {
    return this.req.post<{ ok: boolean }>(`/v1/queues/${enc(this.name)}/fail`, {
      job_id,
      worker_id,
      ...(error !== undefined ? { error } : {}),
    });
  }

  stats(): Promise<QueueStats> {
    return this.req.get<QueueStats>(`/v1/queues/${enc(this.name)}/stats`);
  }

  sweepExpired(): Promise<{ swept: number }> {
    return this.req.delete<{ swept: number }>(
      `/v1/queues/${enc(this.name)}/expired`,
    );
  }
}

// ─── Durable Stream ───────────────────────────────────────────────────────────

export class HonkerStream {
  constructor(
    private readonly name: string,
    private readonly req: HonkerRequester,
  ) {}

  publish(payload: unknown): Promise<{ event_id: number }> {
    return this.req.post<{ event_id: number }>(
      `/v1/streams/${enc(this.name)}/publish`,
      { payload },
    );
  }

  read(options?: ReadEventsOptions): Promise<StreamEvent[]> {
    const p = new URLSearchParams();
    if (options?.consumer !== undefined) p.set("consumer", options.consumer);
    if (options?.since !== undefined) p.set("since", String(options.since));
    if (options?.save) p.set("save", "true");
    return this.req.get<StreamEvent[]>(`/v1/streams/${enc(this.name)}/events${qs(p)}`);
  }

  saveOffset(consumer: string, offset: number): Promise<OffsetResponse> {
    return this.req.put<OffsetResponse>(
      `/v1/streams/${enc(this.name)}/offset/${enc(consumer)}`,
      { offset },
    );
  }

  getOffset(consumer: string): Promise<OffsetResponse> {
    return this.req.get<OffsetResponse>(
      `/v1/streams/${enc(this.name)}/offset/${enc(consumer)}`,
    );
  }
}

// ─── Ephemeral Notifications ──────────────────────────────────────────────────

export class HonkerNotification {
  constructor(
    private readonly channel: string,
    private readonly req: HonkerRequester,
  ) {}

  fire(payload: unknown): Promise<{ ok: boolean }> {
    return this.req.post<{ ok: boolean }>(
      `/v1/notifications/${enc(this.channel)}`,
      { payload },
    );
  }

  poll(options?: PollOptions): Promise<NotificationItem[]> {
    const p = new URLSearchParams();
    if (options?.since !== undefined) p.set("since", String(options.since));
    if (options?.limit !== undefined) p.set("limit", String(options.limit));
    return this.req.get<NotificationItem[]>(
      `/v1/notifications/${enc(this.channel)}/poll${qs(p)}`,
    );
  }

  async *subscribe(signal?: AbortSignal): AsyncGenerator<NotificationItem> {
    const res = await this.req.rawFetch(
      `/v1/notifications/${enc(this.channel)}/subscribe`,
      signal,
    );
    if (!res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data) {
              try {
                yield JSON.parse(data) as NotificationItem;
              } catch {
                // skip malformed SSE frames
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  prune(): Promise<{ pruned: number }> {
    return this.req.delete<{ pruned: number }>(
      `/v1/notifications/${enc(this.channel)}/prune`,
    );
  }
}

// ─── Distributed Lock ─────────────────────────────────────────────────────────

export class HonkerLock {
  constructor(
    private readonly name: string,
    private readonly req: HonkerRequester,
  ) {}

  acquire(options?: { ttl_s?: number }): Promise<{ acquired: boolean }> {
    return this.req.post<{ acquired: boolean }>(`/v1/locks/${enc(this.name)}`, {
      ttl_s: options?.ttl_s ?? 60,
    });
  }

  release(): Promise<{ released: boolean }> {
    return this.req.delete<{ released: boolean }>(`/v1/locks/${enc(this.name)}`);
  }
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

export class HonkerRateLimit {
  constructor(
    private readonly name: string,
    private readonly req: HonkerRequester,
  ) {}

  check(options: RateLimitOptions): Promise<RateLimitResponse> {
    return this.req.post<RateLimitResponse>(
      `/v1/rate-limits/${enc(this.name)}/check`,
      options,
    );
  }

  sweep(): Promise<{ swept: number }> {
    return this.req.delete<{ swept: number }>(
      `/v1/rate-limits/${enc(this.name)}/sweep`,
    );
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export class HonkerScheduler {
  constructor(private readonly req: HonkerRequester) {}

  register(
    options: RegisterHandlerOptions,
  ): Promise<{ handler_name: string; registered: boolean }> {
    return this.req.post<{ handler_name: string; registered: boolean }>(
      "/v1/scheduler",
      options,
    );
  }

  list(): Promise<{ handlers: SchedulerHandler[] }> {
    return this.req.get<{ handlers: SchedulerHandler[] }>("/v1/scheduler");
  }

  tick(worker_id: string): Promise<{ jobs_enqueued: number }> {
    return this.req.post<{ jobs_enqueued: number }>("/v1/scheduler/tick", {
      worker_id,
    });
  }

  next(): Promise<SchedulerNextResponse> {
    return this.req.get<SchedulerNextResponse>("/v1/scheduler/next");
  }

  unregister(
    handler_name: string,
  ): Promise<{ handler_name: string; unregistered: boolean }> {
    return this.req.delete<{ handler_name: string; unregistered: boolean }>(
      `/v1/scheduler/${enc(handler_name)}`,
    );
  }
}

// ─── Job Results ──────────────────────────────────────────────────────────────

export class HonkerJobs {
  constructor(private readonly req: HonkerRequester) {}

  storeResult(
    job_id: number,
    result: unknown,
    ttl_s?: number,
  ): Promise<{ ok: boolean }> {
    return this.req.post<{ ok: boolean }>(`/v1/jobs/${job_id}/result`, {
      result,
      ttl_s: ttl_s ?? 3600,
    });
  }

  getResult(job_id: number): Promise<unknown> {
    return this.req.get<unknown>(`/v1/jobs/${job_id}/result`);
  }

  sweepResults(): Promise<{ swept: number }> {
    return this.req.delete<{ swept: number }>("/v1/jobs/results/sweep");
  }
}

// ─── HonkerClient ─────────────────────────────────────────────────────────────

export class HonkerClient {
  private _scheduler?: HonkerScheduler;
  private _jobs?: HonkerJobs;

  constructor(private readonly req: HonkerRequester) {}

  status(): Promise<HonkerStatusResponse> {
    return this.req.get<HonkerStatusResponse>("/v1/honker/status");
  }

  queue(name: string): HonkerQueue {
    return new HonkerQueue(name, this.req);
  }

  stream(name: string): HonkerStream {
    return new HonkerStream(name, this.req);
  }

  notification(channel: string): HonkerNotification {
    return new HonkerNotification(channel, this.req);
  }

  lock(name: string): HonkerLock {
    return new HonkerLock(name, this.req);
  }

  rateLimit(name: string): HonkerRateLimit {
    return new HonkerRateLimit(name, this.req);
  }

  get scheduler(): HonkerScheduler {
    return (this._scheduler ??= new HonkerScheduler(this.req));
  }

  get jobs(): HonkerJobs {
    return (this._jobs ??= new HonkerJobs(this.req));
  }
}
