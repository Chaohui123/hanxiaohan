import { describe, it, expect } from "vitest";
import { AuthManager } from "../src/auth.js";

describe("AuthManager — multi-store", () => {
  it("stores multiple clients by storeId", () => {
    const mgr = new AuthManager({
      clients: [
        { clientId: "c1", apiKey: "k1", storeId: "store-A" },
        { clientId: "c2", apiKey: "k2", storeId: "store-B" },
      ],
    });

    expect(mgr.listClients()).toHaveLength(2);
    expect(mgr.getHeaders("store-A")).toEqual({ "Client-Id": "c1", "Api-Key": "k1" });
    expect(mgr.getHeaders("store-B")).toEqual({ "Client-Id": "c2", "Api-Key": "k2" });
  });

  it("falls back to clientId as key when no storeId", () => {
    const mgr = new AuthManager({ clients: [{ clientId: "c1", apiKey: "k1" }] });
    expect(mgr.getHeaders("c1")).toEqual({ "Client-Id": "c1", "Api-Key": "k1" });
  });

  it("removeClient works by direct key or clientId match", () => {
    const mgr = new AuthManager({
      clients: [
        { clientId: "c1", apiKey: "k1", storeId: "s1" },
        { clientId: "c2", apiKey: "k2" },
      ],
    });

    expect(mgr.removeClient("s1")).toBe(true);       // by storeId
    expect(mgr.removeClient("c2")).toBe(true);        // by clientId
    expect(mgr.listClients()).toHaveLength(0);
    expect(mgr.removeClient("nonexistent")).toBe(false);
  });

  it("upsertClient adds or updates", () => {
    const mgr = new AuthManager({ clients: [{ clientId: "c1", apiKey: "k1", storeId: "s1" }] });
    mgr.upsertClient({ clientId: "c1", apiKey: "k1-updated", storeId: "s1" });
    expect(mgr.getClient("s1").apiKey).toBe("k1-updated");
    expect(mgr.listClients()).toHaveLength(1);
  });
});
