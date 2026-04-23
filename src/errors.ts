export class FlexDBError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly nodeUrl: string,
  ) {
    super(message);
    this.name = "FlexDBError";
  }
}

export class FlexDBAuthError extends FlexDBError {
  constructor(nodeUrl: string) {
    super("Unauthorized: invalid or missing auth token", 401, nodeUrl);
    this.name = "FlexDBAuthError";
  }
}

export class FlexDBNoLeaderError extends FlexDBError {
  constructor(nodeUrl: string) {
    super("No RAFT leader elected yet — cluster may be initializing", 503, nodeUrl);
    this.name = "FlexDBNoLeaderError";
  }
}

export class FlexDBTransactionError extends FlexDBError {
  constructor(message: string, statusCode: number, nodeUrl: string) {
    super(message, statusCode, nodeUrl);
    this.name = "FlexDBTransactionError";
  }
}

export class FlexDBNoHealthyNodeError extends Error {
  constructor() {
    super("No healthy FlexDB nodes available");
    this.name = "FlexDBNoHealthyNodeError";
  }
}

export class FlexDBTimeoutError extends Error {
  constructor(nodeUrl: string, timeoutMs: number) {
    super(`Request to ${nodeUrl} timed out after ${timeoutMs}ms`);
    this.name = "FlexDBTimeoutError";
  }
}

export class FlexDBHonkerUnavailableError extends FlexDBError {
  constructor(nodeUrl: string, message?: string) {
    super(
      message ?? "Honker extension is not available on this node — rebuild the server with --features honker",
      503,
      nodeUrl,
    );
    this.name = "FlexDBHonkerUnavailableError";
  }
}
