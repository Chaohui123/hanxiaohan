import { Router } from "express";
import { AftersalesManager, type AftersalesCase, type AutoReplyTemplate } from "../services/aftersales-manager.js";

export function createAftersalesRouter(): Router {
  const router = Router();
  const aftersalesManager = new AftersalesManager();

  router.post("/cases", async (req, res) => {
    try {
      const data = req.body as {
        orderId: string;
        postingNumber: string;
        type: AftersalesCase['type'];
        reason: AftersalesCase['reason'];
        description: string;
        buyerName: string;
        buyerMessage: string;
        refundAmountRub?: number;
      };

      const caseItem = aftersalesManager.createCase(data);

      res.status(201).json({
        success: true,
        data: caseItem,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "AFTERSALES_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/cases", async (req, res) => {
    try {
      const { status } = req.query as { status?: AftersalesCase['status'] };
      const cases = aftersalesManager.getCasesByStatus(status);

      res.json({
        success: true,
        data: cases,
        count: cases.length,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "AFTERSALES_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/cases/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const caseItem = aftersalesManager.getCase(id);

      if (!caseItem) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "售后工单不存在", retryable: false },
          correlationId: req.correlationId
        });
      }

      res.json({
        success: true,
        data: caseItem,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "AFTERSALES_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.put("/cases/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body as Partial<Pick<AftersalesCase, 'status' | 'resolutionNote' | 'refundAmountRub'>>;

      const success = aftersalesManager.updateCase(id, updates);

      if (!success) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "售后工单不存在", retryable: false },
          correlationId: req.correlationId
        });
      }

      res.json({
        success: true,
        message: "售后工单已更新",
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "AFTERSALES_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/cases/:id/resolve", async (req, res) => {
    try {
      const { id } = req.params;
      const { resolutionNote, refundAmountRub } = req.body as { resolutionNote: string; refundAmountRub?: number };

      const success = aftersalesManager.resolveCase(id, resolutionNote, refundAmountRub);

      if (!success) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "售后工单不存在", retryable: false },
          correlationId: req.correlationId
        });
      }

      res.json({
        success: true,
        message: "售后工单已解决",
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "AFTERSALES_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/cases/:id/reject", async (req, res) => {
    try {
      const { id } = req.params;
      const { resolutionNote } = req.body as { resolutionNote: string };

      const success = aftersalesManager.rejectCase(id, resolutionNote);

      if (!success) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "售后工单不存在", retryable: false },
          correlationId: req.correlationId
        });
      }

      res.json({
        success: true,
        message: "售后工单已拒绝",
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "AFTERSALES_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/summary", async (req, res) => {
    try {
      const summary = aftersalesManager.getCaseSummary();

      res.json({
        success: true,
        data: summary,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "AFTERSALES_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/templates", async (req, res) => {
    try {
      const templates = aftersalesManager.getTemplates();

      res.json({
        success: true,
        data: templates,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "AFTERSALES_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/templates", async (req, res) => {
    try {
      const template = req.body as Omit<AutoReplyTemplate, 'id'>;
      const newTemplate = aftersalesManager.addAutoReplyTemplate(template);

      res.status(201).json({
        success: true,
        data: newTemplate,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "AFTERSALES_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/cases/:id/flag", async (req, res) => {
    try {
      const { id } = req.params;
      const caseItem = aftersalesManager.getCase(id);

      if (!caseItem) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "售后工单不存在", retryable: false },
          correlationId: req.correlationId
        });
      }

      const flagResult = aftersalesManager.flagPotentialBadReview(caseItem);

      res.json({
        success: true,
        data: flagResult,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "AFTERSALES_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  return router;
}