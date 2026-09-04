// QueryState — react-query 结果的四态渲染（方案 §5.3）：
// loading 骨架屏（保持页面轮廓，禁整页 Spin）/ error 带重试 / empty 插图+引导主行动 / 正常渲染 children
import { ReactNode } from "react";
import { Button, Empty, Result, Skeleton } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import type { UseQueryResult } from "@tanstack/react-query";

export interface QueryStateProps<T> {
  query: UseQueryResult<T, Error>;
  /** 空态文案，默认"暂无数据" */
  emptyText?: string;
  /** 空态引导按钮（跳转型）；无引导意义时不传 */
  emptyAction?: { label: string; to: string };
  children: (data: T) => ReactNode;
}

/** 空数组 / null / undefined / 空对象 视为空态；0、false、空字符串不算空 */
function isEmptyData(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object" && data !== null) return Object.keys(data).length === 0;
  return false;
}

export default function QueryState<T>({ query, emptyText = "暂无数据", emptyAction, children }: QueryStateProps<T>) {
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = query;

  if (isLoading) {
    return <Skeleton active paragraph={{ rows: 5 }} />;
  }

  // 后台轮询失败但已有数据时保留旧数据展示，错误态只在无数据可显示时出现
  if (isError && data === undefined) {
    return (
      <Result
        status="error"
        title="加载失败"
        subTitle={error?.message || "网络或服务异常"}
        extra={
          <Button type="primary" icon={<ReloadOutlined />} onClick={() => refetch()}>
            重试
          </Button>
        }
      />
    );
  }

  if (data === undefined || data === null || isEmptyData(data)) {
    return (
      <Empty description={emptyText} imageStyle={{ height: 80 }}>
        {emptyAction && (
          <Button type="primary" onClick={() => navigate(emptyAction.to)}>
            {emptyAction.label}
          </Button>
        )}
      </Empty>
    );
  }

  return <>{children(data)}</>;
}
