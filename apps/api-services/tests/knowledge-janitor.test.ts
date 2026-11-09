import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ run: vi.fn(), all: vi.fn(), emit: vi.fn() }));
vi.mock("../src/db/connection.js", () => ({ getDb: async () => ({ run: state.run, all: state.all }) }));
vi.mock("../src/services/notification-events.js", () => ({ emitEvent: state.emit }));

import { PLAYBOOK_SUPERSESSIONS, runKnowledgeJanitor } from "../src/services/knowledge-janitor.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.run.mockResolvedValue({ changes: 1 });
  state.emit.mockResolvedValue(undefined);
  state.all.mockImplementation(async (sql: string) => sql.includes("COUNT(*)") ? [{ cnt: 100 }] : [{ id: "pb_followup_reliability_deployed_20261103" }]);
});

describe("knowledge janitor supersession", () => {
  it("deletes only explicitly superseded audits when the current replacement exists", async () => {
    const report = await runKnowledgeJanitor();
    expect(report.superseded).toBe(PLAYBOOK_SUPERSESSIONS.length);
    for (const item of PLAYBOOK_SUPERSESSIONS) {
      expect(state.run).toHaveBeenCalledWith("DELETE FROM rag_operations_playbook WHERE id = $1", [item.id]);
    }
    expect(state.emit).toHaveBeenCalledWith("KNOWLEDGE_JANITOR", expect.objectContaining({ superseded: String(PLAYBOOK_SUPERSESSIONS.length) }));
  });

  it("keeps the old entry and reports an error if the replacement is missing", async () => {
    state.all.mockImplementation(async (sql: string) => sql.includes("COUNT(*)") ? [{ cnt: 100 }] : []);
    const report = await runKnowledgeJanitor();
    expect(report.superseded).toBe(0);
    expect(state.run).not.toHaveBeenCalledWith("DELETE FROM rag_operations_playbook WHERE id = $1", [PLAYBOOK_SUPERSESSIONS[0].id]);
    expect(state.run).not.toHaveBeenCalledWith("DELETE FROM rag_operations_playbook WHERE id = $1", [PLAYBOOK_SUPERSESSIONS[1].id]);
  });
});
