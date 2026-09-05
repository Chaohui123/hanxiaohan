// AlertBell — header notification bell with badge + alert drawer (replaces AlertBanner)
import { useMemo, useState } from "react";
import { Badge, Button, Drawer, Empty, List, Tag, Typography } from "antd";
import { BellOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { useAlerts } from "../../api/dashboard-api";
import { addReadFingerprints, getReadFingerprints } from "../../utils/unread";

/** 告警内容指纹：同型同文同数量视为同一条（count 变化视为新告警，如死信 1→3 应再提醒） */
function fingerprint(a: { type: string; message: string; count?: number }): string {
  return `${a.type}|${a.message}|${a.count ?? 0}`;
}

export default function AlertBell() {
  const [open, setOpen] = useState(false);
  const [readVersion, setReadVersion] = useState(0); // 打开抽屉标记已读后 +1 触发角标重算
  const { data, dataUpdatedAt } = useAlerts();

  const alerts = data || [];

  // 未读角标语义：只统计不在已读指纹集合里的告警；打开抽屉即全部已读（2026-09-05 用户要求）
  const unreadCount = useMemo(() => {
    const readSet = getReadFingerprints();
    return alerts.filter((a) => !readSet.has(fingerprint(a))).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts, readVersion]);

  const handleOpen = () => {
    setOpen(true);
    addReadFingerprints(alerts.map(fingerprint));
    setReadVersion((v) => v + 1);
  };

  return (
    <>
      <Badge count={unreadCount} size="small" offset={[-4, 4]}>
        <Button type="text" icon={<BellOutlined />} onClick={handleOpen} />
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
