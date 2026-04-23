const enc = encodeURIComponent;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BranchInfo {
  name: string;
  is_default: boolean;
}

// ─── Internal HTTP interface ──────────────────────────────────────────────────

export interface BranchesRequester {
  post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  get<T>(path: string): Promise<T>;
  delete<T>(path: string): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
}

// ─── BranchesClient ───────────────────────────────────────────────────────────

export class BranchesClient {
  constructor(private readonly req: BranchesRequester) {}

  list(): Promise<{ branches: BranchInfo[] }> {
    return this.req.get<{ branches: BranchInfo[] }>("/v1/branches");
  }

  create(name: string, from?: string): Promise<{ status: string; name: string; from: string }> {
    const body: { name: string; from?: string } = { name };
    if (from !== undefined) body.from = from;
    return this.req.post("/v1/branches", body);
  }

  get(name: string): Promise<BranchInfo> {
    return this.req.get<BranchInfo>(`/v1/branches/${enc(name)}`);
  }

  delete(name: string): Promise<{ status: string }> {
    return this.req.delete(`/v1/branches/${enc(name)}`);
  }

  rename(name: string, newName: string): Promise<{ status: string; name: string }> {
    return this.req.patch(`/v1/branches/${enc(name)}`, { name: newName });
  }

  /** Switch an open transaction to this branch. Requires a live transaction ID. */
  switch(name: string, transactionId: string): Promise<{ switched_to: string; transaction_id: string }> {
    return this.req.post(
      `/v1/branches/${enc(name)}/switch`,
      {},
      { "X-Transaction-ID": transactionId },
    );
  }
}
