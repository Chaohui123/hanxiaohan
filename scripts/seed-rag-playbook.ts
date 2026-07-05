// ============================================================
// RAG Playbook Seed — reads from rag-playbook-seed.json
// Usage: pnpm seed:rag
// ============================================================

import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDb, getAdapterType } from "../apps/api-services/src/db/connection.js";
import { EmbeddingClient } from "../packages/embedding/src/embedding-client.js";
import { logger } from "../packages/logger/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = process.env.RAG_SEED_PATH || join(__dirname, "rag-playbook-seed.json");
const playbookEntries: Array<{
  title: string; scenario: string; content: string; tags: string[]; priority: number;
}> = JSON.parse(readFileSync(seedPath, "utf-8"));

async function main() {
  logger.info({ path: seedPath, count: playbookEntries.length }, "Starting RAG playbook seed");

  const db = await getDb().catch(() => null);
  if (!db) { logger.error("Database unavailable"); process.exit(1); }

  const embeddingClient = new EmbeddingClient({ maxRetries: 2 });
  const texts = playbookEntries.map((e) => `${e.title}\n${e.content}`);
  let embeddings: { vector: number[] }[];

  try {
    embeddings = await embeddingClient.embedBatch(texts);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Embedding failed — check API keys or use EMBEDDING_PROVIDER=local");
    process.exit(1);
  }

  const isPG = getAdapterType() === "pg";
  let seeded = 0;

  for (let i = 0; i < playbookEntries.length; i++) {
    const entry = playbookEntries[i];
    const id = `playbook_${i}`;
    const vector = embeddings[i].vector;
    const vecStr = `[${vector.join(",")}]`;
    const tagsStr = entry.tags.join(",");

    try {
      if (isPG) {
        await db.run(
          `INSERT INTO rag_operations_playbook (id, title, scenario, content, tags, embedding, author, priority)
           VALUES ($1, $2, $3, $4, $5, $6::vector, 'system', $7)
           ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding, updated_at = NOW()`,
          [id, entry.title, entry.scenario, entry.content, tagsStr, vecStr, entry.priority],
        );
      } else {
        await db.run(
          `INSERT OR REPLACE INTO rag_operations_playbook (id, title, scenario, content, tags, embedding, author, priority, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'system', ?, datetime('now'))`,
          [id, entry.title, entry.scenario, entry.content, tagsStr, JSON.stringify(vector), entry.priority],
        );
      }
      seeded++;
      logger.info({ id, title: entry.title }, "Seeded");
    } catch (err) {
      logger.warn({ id, err: (err as Error).message }, "Failed to seed entry");
    }
  }

  logger.info({ seeded, total: playbookEntries.length }, "RAG playbook seed complete");
  process.exit(0);
}

main();
