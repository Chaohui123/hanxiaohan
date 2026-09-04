// PageContainer — unified page header (title + subtitle + actions + 数据新鲜度) and content wrapper
import { ReactNode } from "react";
import { Typography } from "antd";
import dayjs from "dayjs";

interface PageContainerProps {
  title: string;
  subTitle?: string;
  extra?: ReactNode;
  /** react-query 的 dataUpdatedAt；非空时标题右侧显示"更新于 HH:mm:ss" */
  updatedAt?: number;
  children: ReactNode;
}

export default function PageContainer({ title, subTitle, extra, updatedAt, children }: PageContainerProps) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <Typography.Title level={4} style={{ margin: 0 }}>{title}</Typography.Title>
            {updatedAt != null && updatedAt > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                更新于 {dayjs(updatedAt).format("HH:mm:ss")}
              </Typography.Text>
            )}
          </div>
          {subTitle && <Typography.Text type="secondary">{subTitle}</Typography.Text>}
        </div>
        {extra && <div>{extra}</div>}
      </div>
      {children}
    </div>
  );
}
