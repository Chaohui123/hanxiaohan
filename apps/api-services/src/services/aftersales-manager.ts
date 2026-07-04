export type AftersalesType = 'refund' | 'return' | 'exchange' | 'complaint' | 'question';
export type AftersalesStatus = 'pending' | 'processing' | 'resolved' | 'rejected';
export type RefundReason = 
  | 'no_reason' 
  | 'quality_issue' 
  | 'wrong_item' 
  | 'damaged' 
  | 'late_delivery' 
  | 'change_mind' 
  | 'other';

export interface AftersalesCase {
  id: string;
  orderId: string;
  postingNumber: string;
  type: AftersalesType;
  status: AftersalesStatus;
  reason: RefundReason;
  description: string;
  buyerName: string;
  buyerMessage: string;
  createdAt: string;
  updatedAt: string;
  refundAmountRub?: number;
  resolutionNote?: string;
  attachments: string[];
}

export interface CaseSummary {
  totalCases: number;
  pendingCases: number;
  resolvedCases: number;
  rejectedCases: number;
  avgResolutionHours: number;
  refundRate: number;
}

export interface AutoReplyTemplate {
  id: string;
  name: string;
  reason: RefundReason;
  subject: string;
  body: string;
}

export class AftersalesManager {
  private cases = new Map<string, AftersalesCase>();
  private templates: AutoReplyTemplate[] = [
    {
      id: '1',
      name: '质量问题退款',
      reason: 'quality_issue',
      subject: '关于您的质量问题反馈',
      body: '尊敬的客户，非常抱歉给您带来不好的购物体验。我们已收到您的反馈，将在24小时内处理您的退款申请。退款将在3-5个工作日内原路返回。'
    },
    {
      id: '2',
      name: '错发商品',
      reason: 'wrong_item',
      subject: '关于错发商品的处理',
      body: '尊敬的客户，非常抱歉我们发错了商品。请您将收到的商品寄回，我们将承担运费并尽快为您补发正确的商品。'
    },
    {
      id: '3',
      name: '客户改变主意',
      reason: 'change_mind',
      subject: '关于您的取消申请',
      body: '尊敬的客户，已收到您的取消申请。如果商品尚未发货，我们将立即为您办理退款。如果已发货，请收到后联系我们办理退货。'
    },
    {
      id: '4',
      name: '延迟发货致歉',
      reason: 'late_delivery',
      subject: '发货延迟致歉',
      body: '尊敬的客户，非常抱歉发货延迟给您带来不便。由于物流高峰期，您的包裹可能会延迟1-2天送达，我们深表歉意。'
    }
  ];

  createCase(data: {
    orderId: string;
    postingNumber: string;
    type: AftersalesType;
    reason: RefundReason;
    description: string;
    buyerName: string;
    buyerMessage: string;
    refundAmountRub?: number;
  }): AftersalesCase {
    const caseItem: AftersalesCase = {
      id: crypto.randomUUID(),
      ...data,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attachments: []
    };
    
    this.cases.set(caseItem.id, caseItem);
    return caseItem;
  }

  getCase(id: string): AftersalesCase | undefined {
    return this.cases.get(id);
  }

  updateCase(id: string, updates: Partial<Pick<AftersalesCase, 'status' | 'resolutionNote' | 'refundAmountRub'>>): boolean {
    const caseItem = this.cases.get(id);
    if (!caseItem) return false;
    
    caseItem.status = updates.status ?? caseItem.status;
    caseItem.resolutionNote = updates.resolutionNote ?? caseItem.resolutionNote;
    caseItem.refundAmountRub = updates.refundAmountRub ?? caseItem.refundAmountRub;
    caseItem.updatedAt = new Date().toISOString();
    
    return true;
  }

  resolveCase(id: string, resolutionNote: string, refundAmountRub?: number): boolean {
    return this.updateCase(id, {
      status: 'resolved',
      resolutionNote,
      refundAmountRub
    });
  }

  rejectCase(id: string, resolutionNote: string): boolean {
    return this.updateCase(id, {
      status: 'rejected',
      resolutionNote
    });
  }

  getCasesByStatus(status?: AftersalesStatus): AftersalesCase[] {
    let result = Array.from(this.cases.values());
    
    if (status) {
      result = result.filter(c => c.status === status);
    }
    
    return result.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  getCaseSummary(): CaseSummary {
    const allCases = Array.from(this.cases.values());
    const total = allCases.length;
    const resolved = allCases.filter(c => c.status === 'resolved').length;
    const rejected = allCases.filter(c => c.status === 'rejected').length;
    const pending = allCases.filter(c => c.status === 'pending').length;
    
    const resolvedCasesWithTime = allCases.filter(c => 
      c.status === 'resolved' && c.createdAt && c.updatedAt
    );
    
    const avgResolutionHours = resolvedCasesWithTime.length > 0
      ? resolvedCasesWithTime.reduce((sum, c) => {
          const created = new Date(c.createdAt).getTime();
          const updated = new Date(c.updatedAt).getTime();
          return sum + (updated - created) / (1000 * 60 * 60);
        }, 0) / resolvedCasesWithTime.length
      : 0;
    
    const refundCases = allCases.filter(c => 
      c.type === 'refund' || c.type === 'return'
    ).length;
    
    const refundRate = total > 0 ? (refundCases / total) * 100 : 0;
    
    return {
      totalCases: total,
      pendingCases: pending,
      resolvedCases: resolved,
      rejectedCases: rejected,
      avgResolutionHours: Math.round(avgResolutionHours * 10) / 10,
      refundRate: Math.round(refundRate * 10) / 10
    };
  }

  getAutoReplyTemplate(reason: RefundReason): AutoReplyTemplate | undefined {
    return this.templates.find(t => t.reason === reason);
  }

  addAutoReplyTemplate(template: Omit<AutoReplyTemplate, 'id'>): AutoReplyTemplate {
    const newTemplate: AutoReplyTemplate = {
      ...template,
      id: crypto.randomUUID()
    };
    this.templates.push(newTemplate);
    return newTemplate;
  }

  getTemplates(): AutoReplyTemplate[] {
    return [...this.templates];
  }

  flagPotentialBadReview(caseItem: AftersalesCase): { shouldFlag: boolean; riskLevel: 'low' | 'medium' | 'high' } {
    const riskFactors: number[] = [];
    
    if (caseItem.reason === 'quality_issue') riskFactors.push(3);
    if (caseItem.reason === 'damaged') riskFactors.push(3);
    if (caseItem.reason === 'wrong_item') riskFactors.push(2);
    if (caseItem.status === 'pending' && 
        Date.now() - new Date(caseItem.createdAt).getTime() > 24 * 60 * 60 * 1000) {
      riskFactors.push(2);
    }
    if (caseItem.buyerMessage.length > 200) riskFactors.push(1);
    
    const totalRisk = riskFactors.reduce((sum, r) => sum + r, 0);
    
    if (totalRisk >= 5) return { shouldFlag: true, riskLevel: 'high' };
    if (totalRisk >= 3) return { shouldFlag: true, riskLevel: 'medium' };
    return { shouldFlag: false, riskLevel: 'low' };
  }
}