// ============================================================
// GLM (Zhipu AI) types
// ============================================================

export interface OcrResult {
  rawText: string;
  structured: {
    brand?: string;
    specifications?: string[];
    sellingPoints?: string[];
    dimensions?: string;
    material?: string;
    warnings?: string[];
  };
}

export interface TranslationResult {
  titleRu: string;
  descriptionRu: string;
  specificationsRu: Array<{ name: string; value: string }>;
}

export interface CategoryMatchResult {
  categoryId: number;
  categoryName: string;
  categoryPath: string[];
  confidence: number; // 0.0 - 1.0
  reasoning: string;
}

export interface AttributeFillResult {
  attributes: Array<{
    attributeId: number;
    name: string;
    value: string | number | string[];
  }>;
  confidence: number;
  missingRequired: Array<{ name: string; reason: string }>;
}

export interface GlmApiResponse<T> {
  data: T;
  tokensUsed: number;
  model: string;
}
