from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from src.models import DailyGapFill, WordstatDynamicsResponseNormalized
from src.wordstat_fetcher import WordstatFetcher, WordstatUpstreamError


def fill_daily_gap(
    fetcher: WordstatFetcher,
    weekly: Optional[WordstatDynamicsResponseNormalized],
    run_date: str,
    chunk_days: int = 30,
) -> DailyGapFill:
    if not weekly or weekly.period != "weekly" or not weekly.results:
        return DailyGapFill(
            status="no_weekly_baseline",
            returnedPointsCount=0,
            note="没有有效周序列基准，不猜测daily起点，不补0，也不请求无边界历史数据。",
        )
    if not 1 <= chunk_days <= 30:
        raise ValueError("daily补全单段天数必须在1-30之间")

    last_weekly = date.fromisoformat(weekly.results[-1].date)
    weekly_covered_through = last_weekly + timedelta(days=6)
    cursor = last_weekly + timedelta(days=7)
    target = date.fromisoformat(run_date) - timedelta(days=1)
    if cursor > target:
        return DailyGapFill(
            status="not_needed",
            targetThroughDate=target.isoformat(),
            coveredThroughDate=weekly_covered_through.isoformat(),
            returnedPointsCount=0,
            missingCalendarDays=0,
            note="周序列已覆盖至上一完整周，无需补入当前未完整周。",
        )

    requested_from = cursor
    requested_to: Optional[str] = None
    last_checked_at: Optional[str] = None
    points_by_date = {}
    request_failed = False
    while cursor <= target:
        chunk_end = min(cursor + timedelta(days=chunk_days - 1), target)
        requested_to = chunk_end.isoformat()
        diagnostic_start = len(fetcher.failed_diagnostics)
        try:
            response = fetcher.getDynamics(
                phrase=weekly.phrase,
                from_date=cursor.isoformat(),
                to_date=chunk_end.isoformat(),
                period="daily",
                regions=weekly.regions,
                devices=weekly.devices,
            )
        except WordstatUpstreamError:
            for diagnostic in fetcher.failed_diagnostics[diagnostic_start:]:
                diagnostic.stage = "daily_gap"
            request_failed = True
            break
        last_checked_at = response.capturedAt
        for point in response.results:
            if cursor.isoformat() <= point.date <= chunk_end.isoformat():
                points_by_date[point.date] = point
        if not response.results:
            break
        if not response.sourceAsOf or date.fromisoformat(response.sourceAsOf) < chunk_end:
            break
        cursor = chunk_end + timedelta(days=1)

    points = [points_by_date[key] for key in sorted(points_by_date)]
    daily_as_of = points[-1].date if points else None
    covered_through = max(weekly_covered_through, date.fromisoformat(daily_as_of)) if daily_as_of else weekly_covered_through
    expected_dates = set()
    day = requested_from
    while day <= target:
        expected_dates.add(day.isoformat())
        day += timedelta(days=1)
    missing_dates = sorted(expected_dates.difference(points_by_date))
    if request_failed:
        status = "request_failed" if not points else "partial"
    elif not points:
        status = "no_data"
    elif not missing_dates:
        status = "complete"
    else:
        status = "partial"
    return DailyGapFill(
        status=status,
        requestedFromDate=requested_from.isoformat(),
        requestedToDate=requested_to,
        targetThroughDate=target.isoformat(),
        sourceAsOf=daily_as_of,
        coveredThroughDate=covered_through.isoformat(),
        missingFromDate=missing_dates[0] if missing_dates else None,
        missingCalendarDays=len(missing_dates),
        returnedPointsCount=len(points),
        lastCheckedAt=last_checked_at,
        requestFailed=request_failed,
        points=points,
        note="daily仅保留实际返回点并与weekly分列；缺失日期不补0，不解除weekly过期冻结，也不代表当前日需求。",
    )
