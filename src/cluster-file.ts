import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

export interface ClusterFileNode {
  id: string;
  raft_id: number;
  role: string;
  http_url: string;
  raft_addr: string;
  ip: string;
}

export interface ClusterFile {
  version: string;
  provider: string;
  cluster_id: string;
  created_at: string;
  auth_token: string;
  nodes: ClusterFileNode[];
  leader_url: string;
  http_port: number;
  raft_port: number;
  meta?: Record<string, unknown>;
}

const CLUSTER_FILENAME = ".flexdb-cluster";
const SUPPORTED_VERSION = "1";

/**
 * Load and parse a `.flexdb-cluster` file.
 *
 * @param filePath - Absolute or relative path to the file.
 *                   Defaults to auto-discovery: walks up from `process.cwd()`
 *                   until the file is found or the filesystem root is reached.
 */
export function loadClusterFile(filePath?: string): ClusterFile {
  const resolved = filePath ?? findClusterFile();
  if (!resolved) {
    throw new Error(
      `No .flexdb-cluster file found in ${process.cwd()} or any parent directory. ` +
        "Pass a file path explicitly or create the file.",
    );
  }

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read .flexdb-cluster at ${resolved}: ${msg}`);
  }

  let parsed: ClusterFile;
  try {
    parsed = JSON.parse(raw) as ClusterFile;
  } catch {
    throw new Error(`Invalid JSON in .flexdb-cluster at ${resolved}`);
  }

  if (!parsed.nodes || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error(`.flexdb-cluster at ${resolved} has no nodes defined`);
  }

  if (parsed.version && parsed.version !== SUPPORTED_VERSION) {
    // Warn but continue — spec says treat unknown higher versions gracefully
    console.warn(
      `[flexdb-node] .flexdb-cluster version "${parsed.version}" is newer than ` +
        `supported version "${SUPPORTED_VERSION}" — some fields may be ignored`,
    );
  }

  return parsed;
}

/** Walk up directories from cwd looking for .flexdb-cluster */
function findClusterFile(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, CLUSTER_FILENAME);
    try {
      readFileSync(candidate, "utf8"); // probe
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null; // filesystem root
      dir = parent;
    }
  }
}
