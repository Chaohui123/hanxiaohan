// PageContainer — unified page header (title + subtitle + actions) and content wrapper
import { ReactNode } from "react";
import { Typography } from "antd";

interface PageContainerProps {
  title: string;
  subTitle?: string;
  extra?: ReactNode;
  children: ReactNode;
}

export default function PageContainer({ title, subTitle, extra, children }: PageContainerProps) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{title}</Typography.Title>
          {subTitle && <Typography.Text type="secondary">{subTitle}</Typography.Text>}
        </div>
        {extra && <div>{extra}</div>}
      </div>
      {children}
    </div>
  );
}
