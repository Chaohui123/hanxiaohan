import { describe, it, expect, vi } from 'vitest'
import { syncOrders } from '../src/sync'
import type { OzonPosting } from '@onzo/shared-types'

describe('syncOrders', () => {
  it('processes paginated postings and calls processPosting', async () => {
    const postingsPage1: OzonPosting[] = [
      { postingNumber: 'p1', orderId: 1, orderNumber: 'o1', status: 'awaiting_packaging', createdAt: '', inProcessAt: '', products: [], price: 0, commission: 0, payout: 0, deliveryMethod: '', trackingNumber: '', buyerName: '', buyerPhone: '', buyerEmail: '' },
    ]
    const postingsPage2: OzonPosting[] = [
      { postingNumber: 'p2', orderId: 2, orderNumber: 'o2', status: 'awaiting_packaging', createdAt: '', inProcessAt: '', products: [], price: 0, commission: 0, payout: 0, deliveryMethod: '', trackingNumber: '', buyerName: '', buyerPhone: '', buyerEmail: '' },
    ]

    const client = {
      listPostings: vi.fn().mockImplementationOnce(() => Promise.resolve(postingsPage1)).mockImplementationOnce(() => Promise.resolve(postingsPage2)),
      listFboPostings: vi.fn().mockResolvedValue([]),
    }

    const processPosting = vi.fn(async (_p: OzonPosting) => {})

    const res = await syncOrders({} as unknown as Parameters<typeof syncOrders>[0], { client: client as unknown as Parameters<typeof syncOrders>[1]["client"], processPosting: processPosting as unknown as Parameters<typeof syncOrders>[1]["processPosting"], pageSize: 1 })
    expect(res.total).toBe(2)
    expect(processPosting).toHaveBeenCalledTimes(2)
  })

  it('skips already synced postings based on db local_orders', async () => {
    const postings: OzonPosting[] = [
      { postingNumber: 'p1', orderId: 1, orderNumber: 'o1', status: 'awaiting_packaging', createdAt: '', inProcessAt: '', products: [], price: 0, commission: 0, payout: 0, deliveryMethod: '', trackingNumber: '', buyerName: '', buyerPhone: '', buyerEmail: '' },
    ]

    const client = {
      listPostings: vi.fn().mockResolvedValue(postings),
      listFboPostings: vi.fn().mockResolvedValue([]),
    }

    const mockDb = {
      all: vi.fn().mockImplementation((_sql: string, params?: unknown[]) => {
        if (params && params[0] === "store_1" && params[1] === 1) return Promise.resolve([{ cnt: 1 }])
        return Promise.resolve([{ cnt: 0 }])
      }),
    }

    const processPosting = vi.fn(async (_p: OzonPosting) => {})

    const res = await syncOrders({} as unknown as Parameters<typeof syncOrders>[0], { client: client as unknown as Parameters<typeof syncOrders>[1]["client"], db: mockDb as unknown as Parameters<typeof syncOrders>[1]["db"], processPosting, storeId: "store_1" })
    expect(res.total).toBe(0)
    expect(res.upserted).toBe(0)
    expect(res.skipped).toBe(1)
    expect(processPosting).toHaveBeenCalledTimes(0)
  })
})
