import { Router } from "express";
import { InventoryManager, type InventoryItem, type SupplierInfo } from "../services/inventory-manager.js";

export function createInventoryRouter(): Router {
  const router = Router();
  const inventoryManager = new InventoryManager();

  router.post("/items", async (req, res) => {
    try {
      const items = req.body as InventoryItem[];
      items.forEach(item => inventoryManager.addItem(item));
      
      res.json({
        success: true,
        message: `成功添加 ${items.length} 个库存项`,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/items/:offerId/:sku", async (req, res) => {
    try {
      const { offerId, sku } = req.params;
      const item = inventoryManager.getItem(offerId, parseInt(sku));
      
      if (!item) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "库存项不存在", retryable: false },
          correlationId: req.correlationId
        });
      }
      
      res.json({
        success: true,
        data: item,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.put("/items/:offerId/:sku/stock", async (req, res) => {
    try {
      const { offerId, sku } = req.params;
      const { delta } = req.body as { delta: number };
      
      inventoryManager.updateStock(offerId, parseInt(sku), delta);
      
      res.json({
        success: true,
        message: `库存已更新，变更量: ${delta}`,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/items/:offerId/:sku/reserve", async (req, res) => {
    try {
      const { offerId, sku } = req.params;
      const { quantity } = req.body as { quantity: number };
      
      const success = inventoryManager.reserveStock(offerId, parseInt(sku), quantity);
      
      if (!success) {
        return res.status(400).json({
          success: false,
          error: { code: "INSUFFICIENT_STOCK", message: "库存不足", retryable: false },
          correlationId: req.correlationId
        });
      }
      
      res.json({
        success: true,
        message: `已预留 ${quantity} 件库存`,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/items/:offerId/:sku/release", async (req, res) => {
    try {
      const { offerId, sku } = req.params;
      const { quantity } = req.body as { quantity: number };
      
      inventoryManager.releaseStock(offerId, parseInt(sku), quantity);
      
      res.json({
        success: true,
        message: `已释放 ${quantity} 件预留库存`,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/suppliers", async (req, res) => {
    try {
      const suppliers = req.body as SupplierInfo[];
      suppliers.forEach(supplier => inventoryManager.addSupplier(supplier));
      
      res.json({
        success: true,
        message: `成功添加 ${suppliers.length} 个供应商`,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/suppliers", async (req, res) => {
    try {
      const suppliers = inventoryManager.getSuppliers();
      
      res.json({
        success: true,
        data: suppliers,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/alerts", async (req, res) => {
    try {
      const alerts = inventoryManager.getAlerts();
      
      res.json({
        success: true,
        data: alerts,
        count: alerts.length,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/recommendations", async (req, res) => {
    try {
      const recommendations = inventoryManager.getReorderRecommendations();
      
      res.json({
        success: true,
        data: recommendations,
        count: recommendations.length,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/value", async (req, res) => {
    try {
      const value = inventoryManager.getInventoryValue();
      
      res.json({
        success: true,
        data: value,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  return router;
}