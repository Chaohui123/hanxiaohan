import { getDb } from "../db/connection.js";
import type { Request, Response, NextFunction } from "express";

declare global {
  namespace Express {
    interface Request {
      db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
    }
  }
}

export async function requireDb(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Database unavailable" });
      return;
    }
    req.db = db;
    next();
  } catch (err) {
    res.status(503).json({ error: "Database connection failed" });
  }
}
