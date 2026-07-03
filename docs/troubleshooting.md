# ONZO 故障排查

## 服务无法启动

**症状**: `pnpm dev` 后进程退出

1. 检查 `.env` 是否存在且密钥非空
2. 检查端口 3000 是否被占用: `netstat -ano | findstr 3000`
3. 查看完整错误: `NODE_ENV=development pnpm --filter @onzo/api-services dev`

## Ozon API 返回 404

**症状**: `Ozon API error: 404 Not Found`

**原因**: Ozon API 端点变更

**修复**:
1. 类目树 → 确认使用 `/v1/description-category/tree`
2. 图片上传 → 确认使用 `/v1/product/pictures/import`
3. 检查 `OZON_API_BASE` 是否设为 `https://api-seller.ozon.ru`

## 类目匹配返回 categoryId=0

**症状**: `categoryId=0 on first attempt, retrying...`

- 系统会自动重试一次
- 如果重试仍失败 → 流水线阻断，任务进入死信队列
- 手动检查: 确认 DeepSeek API Key 有效，`DEEPSEEK_API_KEY` 正确

## 图片上传失败

**症状**: `All image URL imports failed`

- 1688 图片可能防盗链 → 系统自动降级本地下载重试
- 确认图片 URL 公网可访问
- 检查 Ozon API Key 权限

## Token 消耗超限

**症状**: `Daily token limit exceeded. All AI calls blocked.`

- 系统自动阻断所有 AI 调用直到次日 0 点 (UTC)
- 临时解除: 调高 `.env` 中 `LLM_DAILY_TOKEN_LIMIT` 后重启
- 监控: `GET /api/stats/llm` 查看消耗

## 数据库锁定

**症状**: `SQLITE_BUSY`

- 系统使用串行写入队列防止锁冲突
- 如果仍然出现: 检查是否有外部进程同时写入 `onzo.db`
- 重启服务: 自动排队重试

## 爬虫无法抓取 1688

**症状**: 页面标题返回 "404-阿里巴巴" 或 "全球领先的采购批发平台"

- 1688 可能检测到爬虫特征
- 调整 `SCRAPER_REQUEST_DELAY_MIN/MAX` 增大延迟
- 检查网络环境是否需要中国大陆代理

## 恢复出厂状态

```bash
# 重置数据库
rm -f data/onzo.db
pnpm --filter @onzo/api-services dev  # 自动重建表结构

# 恢复备份
cp data/backups/onzo-2026-xx-xx.db data/onzo.db
```
