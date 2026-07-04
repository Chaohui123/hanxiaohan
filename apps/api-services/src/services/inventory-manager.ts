export type AlertLevel = 'normal' | 'warning' | 'critical';

export interface InventoryItem {
  offerId: string;
  sku: number;
  stockAvailable: number;
  stockReserved: number;
  safetyStock: number;
  reorderPoint: number;
  supplier: string;
  leadTimeDays: number;
  unitCostCny: number;
  lastUpdated: string;
}

export interface InventoryAlert {
  sku: number;
  offerId: string;
  currentStock: number;
  safetyStock: number;
  reorderPoint: number;
  alertLevel: AlertLevel;
  suggestedOrderQuantity: number;
  estimatedArrivalDays: number;
}

export interface SupplierInfo {
  id: string;
  name: string;
  baseUrl: string;
  reliability: number;
  avgLeadTimeDays: number;
  minOrderQuantity: number;
}

export interface ReorderRecommendation {
  sku: number;
  offerId: string;
  currentStock: number;
  safetyStock: number;
  reorderQuantity: number;
  unitCostCny: number;
  totalCostCny: number;
  suppliers: SupplierInfo[];
  bestSupplier: SupplierInfo | null;
}

export class InventoryManager {
  private items = new Map<string, InventoryItem>();
  private suppliers = new Map<string, SupplierInfo>();

  addItem(item: InventoryItem): void {
    const key = `${item.offerId}:${item.sku}`;
    this.items.set(key, item);
  }

  getItem(offerId: string, sku: number): InventoryItem | undefined {
    return this.items.get(`${offerId}:${sku}`);
  }

  addSupplier(supplier: SupplierInfo): void {
    this.suppliers.set(supplier.id, supplier);
  }

  getSuppliers(): SupplierInfo[] {
    return Array.from(this.suppliers.values());
  }

  updateStock(offerId: string, sku: number, delta: number): void {
    const item = this.getItem(offerId, sku);
    if (item) {
      item.stockAvailable = Math.max(0, item.stockAvailable + delta);
      item.lastUpdated = new Date().toISOString();
    }
  }

  reserveStock(offerId: string, sku: number, quantity: number): boolean {
    const item = this.getItem(offerId, sku);
    if (!item || item.stockAvailable < quantity) {
      return false;
    }
    item.stockAvailable -= quantity;
    item.stockReserved += quantity;
    item.lastUpdated = new Date().toISOString();
    return true;
  }

  releaseStock(offerId: string, sku: number, quantity: number): void {
    const item = this.getItem(offerId, sku);
    if (item) {
      item.stockReserved = Math.max(0, item.stockReserved - quantity);
      item.stockAvailable += quantity;
      item.lastUpdated = new Date().toISOString();
    }
  }

  confirmStock(offerId: string, sku: number, quantity: number): void {
    const item = this.getItem(offerId, sku);
    if (item) {
      item.stockReserved = Math.max(0, item.stockReserved - quantity);
      item.lastUpdated = new Date().toISOString();
    }
  }

  getAlerts(): InventoryAlert[] {
    const alerts: InventoryAlert[] = [];
    
    for (const item of this.items.values()) {
      const level = this.determineAlertLevel(item);
      if (level !== 'normal') {
        alerts.push({
          sku: item.sku,
          offerId: item.offerId,
          currentStock: item.stockAvailable,
          safetyStock: item.safetyStock,
          reorderPoint: item.reorderPoint,
          alertLevel: level,
          suggestedOrderQuantity: this.calculateReorderQuantity(item),
          estimatedArrivalDays: item.leadTimeDays
        });
      }
    }
    
    return alerts.sort((a, b) => {
      const levelOrder = { critical: 0, warning: 1, normal: 2 };
      return levelOrder[a.alertLevel] - levelOrder[b.alertLevel];
    });
  }

  private determineAlertLevel(item: InventoryItem): AlertLevel {
    if (item.stockAvailable <= 0) return 'critical';
    if (item.stockAvailable <= item.safetyStock) return 'warning';
    return 'normal';
  }

  private calculateReorderQuantity(item: InventoryItem): number {
    const avgDailySales = 2;
    const daysToCover = item.leadTimeDays + 7;
    const needed = avgDailySales * daysToCover;
    const shortfall = Math.max(0, needed - item.stockAvailable);
    return Math.ceil(shortfall);
  }

  getReorderRecommendations(): ReorderRecommendation[] {
    const recommendations: ReorderRecommendation[] = [];
    const allSuppliers = this.getSuppliers();
    
    for (const item of this.items.values()) {
      if (item.stockAvailable <= item.reorderPoint) {
        const qty = this.calculateReorderQuantity(item);
        const relevantSuppliers = allSuppliers.filter(s => s.reliability >= 0.7);
        const bestSupplier = relevantSuppliers.length > 0
          ? relevantSuppliers.reduce((best, s) => 
              s.reliability > best.reliability ? s : best
            )
          : null;

        recommendations.push({
          sku: item.sku,
          offerId: item.offerId,
          currentStock: item.stockAvailable,
          safetyStock: item.safetyStock,
          reorderQuantity: qty,
          unitCostCny: item.unitCostCny,
          totalCostCny: qty * item.unitCostCny,
          suppliers: relevantSuppliers,
          bestSupplier
        });
      }
    }
    
    return recommendations.sort((a, b) => a.currentStock - b.currentStock);
  }

  getStockStatus(offerId: string, sku: number): {
    available: number;
    reserved: number;
    status: 'in_stock' | 'low_stock' | 'out_of_stock';
  } {
    const item = this.getItem(offerId, sku);
    if (!item) {
      return { available: 0, reserved: 0, status: 'out_of_stock' };
    }
    
    const status = item.stockAvailable === 0 ? 'out_of_stock' :
                   item.stockAvailable <= item.safetyStock ? 'low_stock' : 'in_stock';
    
    return {
      available: item.stockAvailable,
      reserved: item.stockReserved,
      status
    };
  }

  getInventoryValue(): { totalCostCny: number; totalItems: number } {
    let totalCost = 0;
    let totalItems = 0;
    
    for (const item of this.items.values()) {
      totalCost += item.stockAvailable * item.unitCostCny;
      totalItems += item.stockAvailable;
    }
    
    return { totalCostCny: Math.round(totalCost), totalItems };
  }
}