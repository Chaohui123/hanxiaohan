import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  execFile: vi.fn(),
  getDb: vi.fn(),
  dbAll: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: state.execFile }));
vi.mock("../src/db/connection.js", () => ({ getDb: state.getDb }));

import { FALLBACK_TABLES, fallbackExport, tryPgDump } from "../src/routes/backup.route.js";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
};

function useFakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  }) as FakeChild;
  state.execFile.mockReturnValue(child);
  return child;
}

function closeChild(child: FakeChild, code: number): void {
  child.exitCode = code;
  child.emit("close", code, null);
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "onzo-backup-test-"));
  state.execFile.mockReset();
  state.getDb.mockReset();
  state.getDb.mockResolvedValue({ all: state.dbAll });
  state.dbAll.mockReset();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("backup fallback", () => {
  it("覆盖原表及订单、成本、竞品、调价关键表，并生成可解压的 JSONL gzip", async () => {
    state.dbAll.mockImplementation(async (sql: string) => {
      const table = sql.replace("SELECT * FROM ", "");
      return [{ record_id: `row-${table}` }];
    });
    const outputPath = join(tempDir, "fallback.sql.gz");

    await fallbackExport(outputPath);

    const criticalTables = [
      "ozon_orders",
      "sku_1688_mapping",
      "promo_competitor_prices",
      "promo_pricing_history",
      "promo_competitor_links",
      "promo_audit_log",
    ];
    expect(FALLBACK_TABLES).toEqual(expect.arrayContaining(criticalTables));
    expect(state.dbAll.mock.calls.map(([sql]) => sql)).toEqual(
      FALLBACK_TABLES.map((table) => `SELECT * FROM ${table}`),
    );

    const compressed = await readFile(outputPath);
    expect(compressed.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    const lines = gunzipSync(compressed).toString("utf8").trim().split("\n");
    const records = lines.map((line) => JSON.parse(line));
    expect(records).toHaveLength(FALLBACK_TABLES.length);
    expect(records.map((record) => record.__table)).toEqual(FALLBACK_TABLES);
    expect(records[0]).toEqual({ __table: "task_queue", record_id: "row-task_queue" });
  });

  it("输出流错误时拒绝而不是留下假成功", async () => {
    state.dbAll.mockResolvedValue([]);
    await expect(fallbackExport(join(tempDir, "missing", "fallback.sql.gz"))).rejects.toThrow();
  });

  it("getDb 返回 null 时抛错并清理部分文件", async () => {
    state.getDb.mockResolvedValue(null);
    const outputPath = join(tempDir, "partial.sql.gz");
    await writeFile(outputPath, "partial pg_dump output");

    await expect(fallbackExport(outputPath)).rejects.toThrow("Database unavailable");
    await expect(readFile(outputPath)).rejects.toThrow();
  });

  it("关键表查询失败时带表名抛错并清理部分文件", async () => {
    state.dbAll.mockImplementation(async (sql: string) => {
      if (sql === "SELECT * FROM ozon_orders") throw new Error("permission denied");
      return [{ id: 1 }];
    });
    const outputPath = join(tempDir, "incomplete.sql.gz");

    await expect(fallbackExport(outputPath)).rejects.toThrow(
      "Failed to export table ozon_orders: permission denied",
    );
    await expect(readFile(outputPath)).rejects.toThrow();
  });
});

describe("pg_dump backup", () => {
  it("进程已退出但 gzip 尚未完成时不提前报成功", async () => {
    const child = useFakeChild();
    let settled = false;
    const result = tryPgDump("postgresql://test", join(tempDir, "dump.sql.gz")).then((value) => {
      settled = true;
      return value;
    });

    child.stdout.write("SELECT 1;\n");
    closeChild(child, 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    child.stdout.end();
    await expect(result).resolves.toBe(true);
    const compressed = await readFile(join(tempDir, "dump.sql.gz"));
    expect(gunzipSync(compressed).toString("utf8")).toBe("SELECT 1;\n");
  });

  it("pg_dump 非零退出时返回失败以触发 fallback", async () => {
    const child = useFakeChild();
    const result = tryPgDump("postgresql://test", join(tempDir, "failed.sql.gz"));
    child.stdout.end("partial dump\n");
    closeChild(child, 1);

    await expect(result).resolves.toBe(false);
  });

  it("进程成功但输入流报错时仍返回失败", async () => {
    const child = useFakeChild();
    const result = tryPgDump("postgresql://test", join(tempDir, "stream-error.sql.gz"));
    closeChild(child, 0);
    child.stdout.destroy(new Error("stdout read failed"));

    await expect(result).resolves.toBe(false);
  });

  it("真实子进程输出超过 2 MiB 时不被 maxBuffer 终止且完整压缩", async () => {
    const { execFile: realExecFile } = await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
    const size = 3 * 1024 * 1024;
    state.execFile.mockImplementation((_command, _args, options) =>
      realExecFile(
        process.execPath,
        ["-e", `process.stdout.write("x".repeat(${size}))`],
        options,
      ),
    );
    const outputPath = join(tempDir, "large-real-child.sql.gz");

    await expect(tryPgDump("postgresql://test", outputPath)).resolves.toBe(true);

    const decompressed = gunzipSync(await readFile(outputPath));
    expect(decompressed).toHaveLength(size);
    expect(decompressed.equals(Buffer.alloc(size, "x"))).toBe(true);
  });
});
