// 时间展示工具 — dayjs 相对时间（中文），插件与 locale 集中在此配置
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

/** 相对时间："3 小时前"；空值返回 "—" */
export function fromNow(iso?: string | null): string {
  if (!iso) return "—";
  return dayjs(iso).fromNow();
}

/** 距未来时刻的剩余小时数（可为负，负值即已超时） */
export function hoursUntil(iso?: string | null): number | null {
  if (!iso) return null;
  return dayjs(iso).diff(dayjs(), "hour", true);
}
