#!/bin/bash
# ============================================================
# ONZO 完整业务流程：选品 → 上架 → 推广 → 出单
# 用法: bash scripts/run-business-flow.sh [关键词]
# 默认关键词: 蓝牙耳机
# ============================================================
set -e

API="http://localhost:3000"
KEY="${API_KEY:-onzo-dev-shared-key-2026}"
KEYWORD="${1:-蓝牙耳机}"
H="Content-Type: application/json"

echo "=========================================="
echo " ONZO 完整业务流程测试"
echo " API: $API"
echo " 关键词: $KEYWORD"
echo "=========================================="
echo ""

# ---- 1. 健康检查 ----
echo "=== 1. 健康检查 ==="
HEALTH=$(curl -s -H "X-API-Key: $KEY" "$API/api/health/extended" 2>/dev/null || echo '{"data":{"status":"down"}}')
echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
STATUS=$(echo "$HEALTH" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$STATUS" != "healthy" ]; then
  echo "❌ 健康检查失败: $STATUS"
  echo "请先运行: pnpm dev:api"
  exit 1
fi
echo "✅ API 服务健康"
echo ""

# ---- 2. 关键词自动选品 (A 路径) ----
echo "=== 2. 关键词自动选品: $KEYWORD ==="
RESULT=$(curl -s -X POST \
  -H "$H" \
  -H "X-API-Key: $KEY" \
  "$API/api/auto-select" \
  -d "{\"keyword\":\"$KEYWORD\"}" 2>/dev/null)

echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"

PASSED=$(echo "$RESULT" | grep -o '"validationPassed":[^,}]*' | cut -d: -f2)
TASK_ID=$(echo "$RESULT" | grep -o '"listingTaskId":"[^"]*"' | cut -d'"' -f4)
CANDIDATES=$(echo "$RESULT" | grep -o '"candidates":[0-9]*' | cut -d: -f2)

echo ""
echo "  候选商品数: $CANDIDATES"
echo "  验证通过: $PASSED"
echo "  上架任务ID: $TASK_ID"
echo ""

# ---- 3. 如果验证失败，显示诊断 ----
if [ "$PASSED" = "false" ] || [ -z "$PASSED" ]; then
  echo "=== 3. 诊断信息 ==="
  curl -s -H "X-API-Key: $KEY" \
    "$API/api/market/diagnosis/$KEYWORD" 2>/dev/null | \
    python3 -m json.tool 2>/dev/null || echo "(无诊断数据)"
  echo ""
fi

# ---- 4. 等待30秒让上架任务完成 ----
if [ -n "$TASK_ID" ] && [ "$TASK_ID" != "null" ]; then
  echo "=== 4. 等待30秒 ==="
  sleep 30

  echo "=== 5. 查询任务状态 ==="
  STATUS_RESULT=$(curl -s -H "X-API-Key: $KEY" \
    "$API/api/workflow/status?taskId=$TASK_ID" 2>/dev/null)
  echo "$STATUS_RESULT" | python3 -m json.tool 2>/dev/null || echo "$STATUS_RESULT"
  echo ""
fi

# ---- 6. 同步订单 ----
echo "=== 6. 同步 Ozon 订单 ==="
ORDER_RESULT=$(curl -s -X POST \
  -H "$H" \
  -H "X-API-Key: $KEY" \
  "$API/api/v1/orders/sync" \
  -d '{}' 2>/dev/null)
echo "$ORDER_RESULT" | python3 -m json.tool 2>/dev/null || echo "$ORDER_RESULT"
echo ""

# ---- 7. 查看大盘 ----
echo "=== 7. 大盘数据 ==="
DASHBOARD=$(curl -s -H "X-API-Key: $KEY" \
  "$API/api/v1/dashboard" 2>/dev/null)
echo "$DASHBOARD" | python3 -m json.tool 2>/dev/null || echo "$DASHBOARD"
echo ""

echo "=========================================="
echo " ✅ 业务流程执行完成"
echo "=========================================="
echo ""
echo "后续操作:"
echo "  - 查看订单: curl -H 'X-API-Key: $KEY' $API/api/v1/orders"
echo "  - 查看库存: curl -H 'X-API-Key: $KEY' $API/api/v1/inventory/items"
echo "  - 启动推广Agent: cd apps/promo-agent && npx tsx src/index.ts"
echo "  - 飞书群发送: /promo auto run  (手动触发推广决策)"
echo "  - 飞书群发送: select $KEYWORD  (交互式选品)"
