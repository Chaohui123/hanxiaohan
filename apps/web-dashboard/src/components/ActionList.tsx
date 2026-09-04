// ActionList — 工作台「需要你处理」行动清单：发货超时 / 失败任务 / 库存预警 / COS 死信
import { Link } from "react-router-dom";
import { Card, List, Typography } from "antd";
import {
  ClockCircleOutlined, ExclamationCircleOutlined, InboxOutlined,
  CloudOutlined, CheckCircleOutlined, RightOutlined,
} from "@ant-design/icons";
import { useCosStats } from "../api/dashboard-api";
import { useAwaitingDeliverOrders } from "../api/order-api";
import { useFailedTasks } from "../api/task-api";
import { useInventoryAlerts } from "../api/inventory-api";
import { hoursUntil } from "../utils/time";

export default function ActionList() {
  const { data: orders } = useAwaitingDeliverOrders();
  const { data: failed } = useFailedTasks();
  const { data: alerts } = useInventoryAlerts();
  const { data: cos } = useCosStats();

  // 发货截止距今 < 24h 的订单，按最紧急排序取前 3
  const urgent = (orders || [])
    .map((o) => ({ postingNumber: o.posting_number, hours: hoursUntil(o.shipmentDeadline) }))
    .filter((o): o is { postingNumber: string; hours: number } => o.hours !== null && o.hours < 24)
    .sort((a, b) => a.hours - b.hours)
    .slice(0, 3);

  const failedCount = failed?.length || 0;
  const alertCount = alerts?.length || 0;
  const cosDead = Number(cos?.deadLetter) || 0;

  const allClear = urgent.length === 0 && failedCount === 0 && alertCount === 0 && cosDead === 0;

  if (allClear) {
    return (
      <Card title="需要你处理" style={{ marginTop: 16 }}>
        <Typography.Text style={{ color: "#10b981" }}>
          <CheckCircleOutlined /> 全部处理完毕
        </Typography.Text>
      </Card>
    );
  }

  return (
    <Card title="需要你处理" style={{ marginTop: 16 }}>
      <List size="small" split={false}>
        <List.Item extra={<Link to="/orders">去发货 <RightOutlined /></Link>}>
          <List.Item.Meta
            avatar={<ClockCircleOutlined style={{ color: "#ef4444", fontSize: 18 }} />}
            title={urgent.length > 0 ? `${urgent.length} 个订单临近发货超时` : "临近发货超时"}
            description={
              urgent.length === 0 ? (
                <Typography.Text style={{ color: "#10b981" }}>✅ 无紧急发货</Typography.Text>
              ) : (
                <div>
                  {urgent.map((o) => (
                    <div key={o.postingNumber}>
                      <Typography.Text>{o.postingNumber}</Typography.Text>
                      <Typography.Text style={{ marginLeft: 8, color: o.hours < 12 ? "#ef4444" : undefined }}>
                        {o.hours < 0 ? `已超时 ${Math.floor(-o.hours)}h` : `剩 ${Math.floor(o.hours)}h`}
                      </Typography.Text>
                    </div>
                  ))}
                </div>
              )
            }
          />
        </List.Item>

        {failedCount > 0 && (
          <List.Item>
            <Link to="/tasks?tab=failed">
              <ExclamationCircleOutlined style={{ color: "#f59e0b" }} /> {failedCount} 条失败任务待处理 <RightOutlined />
            </Link>
          </List.Item>
        )}

        {alertCount > 0 && (
          <List.Item>
            <Link to="/inventory">
              <InboxOutlined style={{ color: "#f59e0b" }} /> {alertCount} 个库存预警 <RightOutlined />
            </Link>
          </List.Item>
        )}

        {cosDead > 0 && (
          <List.Item>
            <Link to="/monitoring">
              <CloudOutlined style={{ color: "#f59e0b" }} /> COS 死信图片 {cosDead} 张，建议清理 <RightOutlined />
            </Link>
          </List.Item>
        )}
      </List>
    </Card>
  );
}
