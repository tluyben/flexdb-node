import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeManager } from "../../src/node-manager.js";

describe("NodeManager — single node", () => {
  it("always returns the same node", () => {
    const m = new NodeManager(["http://localhost:4001"], 60_000, 5_000);
    for (let i = 0; i < 5; i++) {
      assert.equal(m.next().url, "http://localhost:4001");
    }
    m.destroy();
  });

  it("strips trailing slash from URL", () => {
    const m = new NodeManager(["http://localhost:4001/"], 60_000, 5_000);
    assert.equal(m.next().url, "http://localhost:4001");
    m.destroy();
  });
});

describe("NodeManager — multiple nodes", () => {
  it("round-robins over healthy nodes", () => {
    const m = new NodeManager(
      ["http://a:4001", "http://b:4001", "http://c:4001"],
      60_000,
      5_000,
    );
    const urls = [m.next().url, m.next().url, m.next().url, m.next().url];
    // All three should appear; fourth wraps around
    assert.ok(urls.includes("http://a:4001"));
    assert.ok(urls.includes("http://b:4001"));
    assert.ok(urls.includes("http://c:4001"));
    m.destroy();
  });

  it("skips unhealthy nodes after 2 failures", () => {
    const m = new NodeManager(
      ["http://a:4001", "http://b:4001"],
      60_000,
      5_000,
    );
    m.markFailed("http://a:4001");
    m.markFailed("http://a:4001"); // second failure → unhealthy
    for (let i = 0; i < 6; i++) {
      assert.equal(m.next().url, "http://b:4001");
    }
    m.destroy();
  });

  it("restores a recovered node after markHealthy", () => {
    const m = new NodeManager(
      ["http://a:4001", "http://b:4001"],
      60_000,
      5_000,
    );
    m.markFailed("http://a:4001");
    m.markFailed("http://a:4001");
    m.markHealthy("http://a:4001");
    const urls = new Set([m.next().url, m.next().url, m.next().url, m.next().url]);
    assert.ok(urls.has("http://a:4001"));
    m.destroy();
  });

  it("falls back to all nodes when all are marked unhealthy", () => {
    const m = new NodeManager(["http://a:4001", "http://b:4001"], 60_000, 5_000);
    m.markFailed("http://a:4001");
    m.markFailed("http://a:4001");
    m.markFailed("http://b:4001");
    m.markFailed("http://b:4001");
    // Should not throw — resets all to healthy
    const node = m.next();
    assert.ok(["http://a:4001", "http://b:4001"].includes(node.url));
    m.destroy();
  });

  it("throws when constructed with empty array", () => {
    assert.throws(() => new NodeManager([], 60_000, 5_000), /at least one/i);
  });
});
