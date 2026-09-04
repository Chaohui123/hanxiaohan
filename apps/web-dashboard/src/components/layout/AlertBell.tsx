// AlertBell — header notification bell with badge + alert drawer (replaces AlertBanner)
import { useState } from "react";
import { Badge, Button, Drawer, Empty, List, Tag, Typography } from "antd";
import { BellOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import { dashboardApi } from "../../api/client";

interface AlertItem { type: string; level: string; message: string; count: number }

export default function AlertBell() {
  const [open, setOpen] = useState(false);
  const { data, dataUpdatedAt } = useQuery({
    queryKey: ["alerts"],
    queryFn: () => dashboardApi.alerts(),
    refetchInterval: 30_000,
  });

  const alerts = (data as { data?: AlertItem[] })?.data || [];

  return (
    <>
      <Badge count={alerts.length} size="small" offset={[-4, 4]}>
        <Button type="text" icon={<BellOutlined />} onClick={() => setOpen(true)} />
      </Badge>
      <Drawer
        title="告警通知"
        width={400}
        open={open}
        onClose={() => setOpen(false)}
      >
        {dataUpdatedAt > 0 && (
          <Typography.Text type="secondary" style={{ display: "block", marginBottom: 12, fontSize: 12 }}>
            更新于 {dayjs(dataUpdatedAt).format("HH:mm:ss")}（每 30 秒自动刷新）
          </Typography.Text>
        )}
        {alerts.length === 0 ? (
          <Empty description="暂无告警" />
        ) : (
          <List
            dataSource={alerts}
            renderItem={(a) => (
              <List.Item key={a.type}>
                <List.Item.Meta
                  title={
                    <span>
                      <Tag color={a.level === "critical" ? "red" : "orange"}>
                        {a.level === "critical" ? "严重" : "警告"}
                      </Tag>
                      {a.message}
                    </span>
                  }
                  description={
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      类型: {a.type} ｜ 数量: {a.count}
                    </Typography.Text>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>
    </>
  );
}
