import { afterAll, describe, expect, it, vi } from "vitest";
import { createSqliteTestDb } from "./helpers/test-db.js";

vi.mock("@onzo/embedding", () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue({ vector: [0.1, 0.2] }),
  })),
}));

import { searchPlaybook } from "../src/routes/rag.route.js";

const sqlite = createSqliteTestDb();
sqlite.db.exec(`
  CREATE TABLE rag_operations_playbook (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    scenario TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,
    embedding TEXT,
    author TEXT DEFAULT 'system',
    priority INTEGER DEFAULT 0
  );
  INSERT INTO rag_operations_playbook (id, title, scenario, content, priority)
  VALUES
    ('low', '防冻液检查', 'ops', '冬季检查清单', 2),
    ('high', '冬季运营', 'ops', '防冻与保温操作指南', 8),
    ('other-scenario', '防冻学习资料', 'learning', '理论说明', 10),
    ('unrelated', '售后回复', 'ops', '订单问题处理', 10);
`);

afterAll(() => sqlite.close());

describe("playbook search SQLite fallback", () => {
  it("returns real LIKE matches with scenario filtering, priority ordering and topK", async () => {
    const rows = await searchPlaybook(sqlite.adapter, "防冻", "ops", 2);

    expect(rows.map((row) => row.id)).toEqual(["high", "low"]);
    expect(rows[0]).toMatchObject({
      scenario: "ops",
      content: "防冻与保温操作指南",
      priority: 8,
    });
  });

  it("rethrows SQLite errors unrelated to vector support", async () => {
    const error = Object.assign(new Error("no such table: rag_operations_playbook"), { name: "SqliteError" });
    const db = { all: vi.fn().mockRejectedValue(error) };

    await expect(searchPlaybook(db as never, "防冻", "ops", 2)).rejects.toBe(error);
    expect(db.all).toHaveBeenCalledTimes(1);
  });
});
