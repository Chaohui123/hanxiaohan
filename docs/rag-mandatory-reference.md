# RAG 向量知识库 — Agent 强制引用规范

> **状态**：已上线（Phase2） | **强制级别**：所有 Agent 必须遵守 | **关联约束**：`.claude/rules.md`

---

## 一、总则

所有 Agent 模块在执行业务决策、生成内容、分析数据前，**必须先查询 RAG 知识库**获取历史经验和参考信息。禁止跳过知识库直接决策。

**核心原则**：
- **先查后决策**（Query-First）：任何决策动作前，先检索知识库
- **写回闭环**（Write-Back）：决策结果和执行反馈必须回写知识库
- **降级容错**（Graceful Degradation）：知识库不可用时允许降级，但必须记录日志

---

## 二、知识库架构

### 技术栈
| 组件 | 技术选型 | 说明 |
|------|---------|------|
| 向量存储 | PostgreSQL + pgvector | 替代 Qdrant，生产环境已部署 |
| Embedding 模型 | 智谱 embedding-3 | 2048 维，通过 `packages/embedding` 调用 |
| 相似度算法 | 余弦相似度（cosine） | `<=>` 操作符，1 - distance = score |
| 索引策略 | IVFFlat | 数据量 >10万条时自动启用 |

### 五大知识库表

| 表名 | 用途 | 关联 Agent |
|------|------|-----------|
| `rag_aftersales_scripts` | 售后话术库 | ops-agent, api-services |
| `rag_competitor_reports` | 竞品分析报告 | promo-agent/competitor-watch |
| `rag_product_knowledge` | 选品知识库 | promo-agent/decision-engine |
| `rag_copy_templates` | 推广文案模板 | promo-agent/copywriter |
| `rag_operations_playbook` | 运营经验手册 | 所有 Agent |

---

## 三、API 端点清单（强制使用）

所有端点基础路径：`{API_BASE}/api/rag/`

### 3.1 售后话术（aftersales）

| 方法 | 端点 | 用途 |
|------|------|------|
| POST | `/rag/aftersales/search` | 搜索售后话术 |
| POST | `/rag/aftersales` | 新增售后话术 |
| PUT | `/rag/aftersales/:id/feedback` | 话术反馈（有效/无效） |
| POST | `/rag/import/aftersales-history` | 批量导入历史售后记录 |

**搜索请求体**：
```json
{
  "query": "买家要求退货但商品已拆封",
  "category": "return",
  "topK": 5
}
```

### 3.2 竞品分析（competitor）

| 方法 | 端点 | 用途 |
|------|------|------|
| POST | `/rag/competitor/search` | 搜索竞品分析报告 |
| POST | `/rag/competitor` | 新增竞品分析 |
| POST | `/rag/import/competitor-history` | 批量导入历史竞品数据 |

### 3.3 选品知识（product）

| 方法 | 端点 | 用途 |
|------|------|------|
| POST | `/rag/product/search` | 搜索选品知识 |
| POST | `/rag/product` | 新增选品知识 |

### 3.4 推广文案（copy）

| 方法 | 端点 | 用途 |
|------|------|------|
| POST | `/rag/copy/search` | 搜索优秀文案模板 |
| POST | `/rag/copy` | 新增文案模板 |

### 3.5 运营经验（playbook）

| 方法 | 端点 | 用途 |
|------|------|------|
| POST | `/rag/playbook/search` | 搜索运营经验 |
| POST | `/rag/playbook` | 新增运营经验 |

### 3.6 统计与维护

| 方法 | 端点 | 用途 |
|------|------|------|
| GET | `/rag/stats` | 知识库统计（各表记录数） |

---

## 四、各 Agent 模块强制引用规则

### 4.1 decision-engine（决策引擎）✅ 已集成

| 决策环节 | 必须查询的知识库 | API 端点 | 状态 |
|---------|----------------|---------|------|
| 商品评分前 | 运营经验手册 | `/rag/playbook/search` | ✅ |
| 执行动作后 | 运营经验手册（写回） | `/rag/playbook` | ✅ |

代码位置：`apps/promo-agent/src/decision-engine.ts:448-461`

### 4.2 copywriter（文案生成）✅ 已集成

| 文案环节 | 必须查询的知识库 | API 端点 | 状态 |
|---------|----------------|---------|------|
| 生成文案前 | 推广文案模板 | `/rag/copy/search` | ✅ |
| 生成文案后 | 推广文案模板（写回） | `/rag/copy` | ✅ |

代码位置：`apps/promo-agent/src/copywriter.ts:112-135`

### 4.3 competitor-watch（竞品监控）✅ 已集成

| 监控环节 | 必须查询的知识库 | API 端点 | 状态 |
|---------|----------------|---------|------|
| 生成警报时 | 竞品分析报告 | `/rag/competitor/search` | ✅ |

代码位置：`apps/promo-agent/src/competitor-watch.ts:256-277`

### 4.4 smart-pricing（智能定价）✅ 已集成

| 定价环节 | 必须查询的知识库 | API 端点 | 状态 |
|---------|----------------|---------|------|
| 生成定价建议前 | 运营经验手册（定价策略） | `/rag/playbook/search` | ✅ |
| 生成定价建议前 | 竞品分析报告 | `/rag/competitor/search` | ✅ |
| 定价执行后 | 运营经验手册（写回） | `/rag/playbook` | ✅ |

代码位置：`apps/promo-agent/src/smart-pricing.ts:217-253`

### 4.5 performance（绩效报告）✅ 已集成

| 报告环节 | 必须查询的知识库 | API 端点 | 状态 |
|---------|----------------|---------|------|
| 生成周报建议时 | 运营经验手册 | `/rag/playbook/search` | ✅ |
| 生成效果回顾时 | 推广文案模板 | `/rag/copy/search` | ✅ |

代码位置：`apps/promo-agent/src/performance.ts:390-490`

### 4.6 cross-validator（交叉验证）✅ 已集成

| 验证环节 | 必须查询的知识库 | API 端点 | 状态 |
|---------|----------------|---------|------|
| 预算检查时 | 运营经验手册（预算策略） | `/rag/playbook/search` | ✅ |

代码位置：`apps/promo-agent/src/cross-validator.ts:171-187`

### 4.7 ops-agent / patrol（巡检）✅ 已集成

| 巡检环节 | 必须查询的知识库 | API 端点 | 状态 |
|---------|----------------|---------|------|
| 异常诊断时 | 运营经验手册 | `/rag/playbook/search` | ✅ |
| 售后相关异常 | 售后话术库 | `/rag/aftersales/search` | ✅ |

代码位置：`apps/ops-agent/src/patrol.ts:44-88`

### 4.8 ops-agent / ai-diagnose（AI诊断）✅ 已集成

| 诊断环节 | 必须查询的知识库 | API 端点 | 状态 |
|---------|----------------|---------|------|
| 生成诊断建议前 | 运营经验手册 | `/rag/playbook/search` | ✅ |

代码位置：`apps/ops-agent/src/ai-diagnose.ts:20-36`

### 4.9 aftersales-manager（售后管理）✅ 已集成

| 售后环节 | 必须查询的知识库 | 状态 |
|---------|----------------|------|
| 自动回复时 | 售后话术库（直接SQL） | ✅ |

代码位置：`apps/api-services/src/services/aftersales-manager.ts:139-207`

---

## 五、RAG 查询标准模式

所有 Agent 必须遵循此模式：

```typescript
async function queryRagKnowledge(
  apiBase: string,
  endpoint: string,
  query: string,
  options?: { scenario?: string; category?: string; topK?: number }
): Promise<string | null> {
  try {
    const resp = await fetch(`${apiBase}/api/rag/${endpoint}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, ...options, topK: options?.topK || 3 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { results?: Array<{ content: string; score: number }> };
    if (!data.results?.length) return null;
    return data.results
      .filter(r => r.score >= 0.7)
      .map(r => r.content)
      .join("\n");
  } catch (err) {
    logger.warn({ endpoint, query, err: (err as Error).message }, "RAG query degraded");
    return null;
  }
}
```

**关键参数**：
- `topK`：默认 3，最多 10
- `score` 阈值：>= 0.7 才采纳
- 超时：5 秒
- 降级：失败返回 null，调用方继续执行但记录日志

---

## 六、RAG 写回标准模式

```typescript
async function writeRagKnowledge(
  apiBase: string,
  endpoint: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    await fetch(`${apiBase}/api/rag/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    logger.warn({ endpoint, err: (err as Error).message }, "RAG write-back failed (non-blocking)");
  }
}
```

| 触发事件 | 写回端点 | 写回内容 |
|---------|---------|---------|
| 文案生成成功 | `/rag/copy` | category, original_text, optimized_text |
| 定价执行完成 | `/rag/playbook` | scenario=pricing, 定价结果和效果 |
| 竞品分析完成 | `/rag/competitor` | offer_id, report_text, price_trend_summary |
| 售后话术反馈 | `/rag/aftersales/:id/feedback` | effective: boolean |
| 决策执行结果 | `/rag/playbook` | scenario=decision, 执行结果和教训 |

---

## 七、环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `EMBEDDING_PROVIDER` | `zhipu` | Embedding 提供商 |
| `EMBEDDING_MODEL` | `embedding-3` | 模型名称 |
| `EMBEDDING_DIMENSIONS` | `2048` | 向量维度 |
| `EMBEDDING_API_KEY` | `${GLM_API_KEY}` | API 密钥 |
| `EMBEDDING_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | API 地址 |
| `EMBEDDING_BATCH_SIZE` | `16` | 批量向量化大小 |
| `RAG_INDEX_INTERVAL_MINUTES` | `60` | 索引调度间隔（分钟） |
| `RAG_SIMILARITY_THRESHOLD` | `0.7` | 相似度阈值 |

---

## 八、集成状态总览

| Agent 模块 | 知识库查询 | 知识库写回 | 状态 |
|-----------|-----------|-----------|------|
| decision-engine | ✅ playbook | ✅ playbook | 已完成 |
| copywriter | ✅ copy | ✅ copy | 已完成 |
| competitor-watch | ✅ competitor | ✅ competitor | 已完成 |
| smart-pricing | ✅ playbook + competitor | ✅ playbook | 已完成 |
| performance | ✅ playbook + copy | ❌ | 已完成 |
| cross-validator | ✅ playbook | ❌ | 已完成 |
| ops-agent/patrol | ✅ playbook + aftersales | ❌ | 已完成 |
| ops-agent/ai-diagnose | ✅ playbook | ❌ | 已完成 |
| aftersales-manager | ✅ aftersales | ❌ | 已完成 |

**优先级排序**：
1. 🔴 **smart-pricing** — 定价决策直接影响利润，必须优先集成
2. 🟡 **performance** — 周报建议需要历史经验支撑
3. 🟡 **cross-validator** — 预算检查需要策略参考
4. 🟢 **ops-agent** — 巡检诊断可后续集成