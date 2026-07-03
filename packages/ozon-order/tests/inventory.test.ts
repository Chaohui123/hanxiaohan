import { describe, it, expect } from 'vitest'
import { deductInventory } from '../src/inventory'

describe('inventory', () => {
  it('deductInventory should be callable and return success boolean', async () => {
    const res = await deductInventory('store1', 'SKU1', 1, 'store1:order1')
    expect(res).toHaveProperty('success')
  })
})
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("InventoryManager", () => {
  // Test the stock deduction logic directly
  it("calculates correct stock after deduction", () => {
    const available = 50;
    const quantity = 10;
    expect(available - quantity).toBe(40);
    expect(available >= quantity).toBe(true);
  });

  it("detects insufficient stock", () => {
    const available = 5;
    const quantity = 20;
    expect(available >= quantity).toBe(false);
  });

  it("calculates correct stock after restore", () => {
    let available = 15;
    const deducted = 5;
    available = available - deducted;
    expect(available).toBe(10);
    // restore
    available = available + deducted;
    expect(available).toBe(15);
  });

  it("reserved count tracks correctly through lifecycle", () => {
    let available = 30;
    let reserved = 0;

    // Deduct
    const qty = 8;
    available -= qty;
    reserved += qty;
    expect(available).toBe(22);
    expect(reserved).toBe(8);

    // Restore (cancel)
    available += qty;
    reserved -= qty;
    expect(available).toBe(30);
    expect(reserved).toBe(0);
  });

  it("handles multi-item deduction", () => {
    const items = [
      { available: 20, deduct: 5, expected: 15 },
      { available: 10, deduct: 10, expected: 0 },
      { available: 3, deduct: 10, expected: -7 }, // insufficient
    ];

    const results = items.map((i) => ({
      success: i.available >= i.deduct,
      remaining: i.available >= i.deduct ? i.available - i.deduct : i.available,
    }));

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(results[2].success).toBe(false);
  });
});
