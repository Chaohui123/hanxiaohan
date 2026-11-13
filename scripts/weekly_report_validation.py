from datetime import datetime, timezone


def parse_time(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def age_hours(value, now):
    parsed = parse_time(value)
    if parsed is None:
        return None
    return round((now - parsed).total_seconds() / 3600, 2)


def validate_source(source, now=None):
    now = now or datetime.now(timezone.utc)
    collected_at = source.get("collectedAt")
    age = age_hours(collected_at, now)
    stale = age is None or age > 36 or parse_time(collected_at) > now
    return {
        "collectedAt": collected_at,
        "ageHours": age,
        "stale": stale,
        "usable": not stale,
        "reason": None if not stale else "source collectedAt is missing, future-dated, or older than 36h",
    }


def validate_competitor_report(report, now=None, last_run=None):
    now = now or datetime.now(timezone.utc)
    totals = report.get("totals") or {}
    failure_counts = {}
    for key, legacy_key in (("comparisonFetchFailed", "fetchFailed"), ("comparisonIdentityMismatch", "identityMismatch"), ("comparisonMissingRequired", None), ("uploadFailures", None)):
        value = totals.get(key)
        failure_counts[key] = int(value if value is not None else (totals.get(legacy_key) if legacy_key else 0) or 0)
    filters = report.get("filters") or {}
    filtered = bool(filters.get("offerId") or filters.get("limit"))
    run_state_usable = False
    run_state_reason = None
    if last_run is None:
        run_state_reason = "latest run-state evidence is missing"
    else:
        last_filters = last_run.get("filters") or {}
        if last_run.get("fatalError"):
            run_state_reason = "latest run failed: " + str(last_run.get("fatalError"))
        elif last_run.get("dryRun"):
            run_state_reason = "latest run is a dry-run, not production evidence"
        elif last_filters.get("offerId") or last_filters.get("limit"):
            run_state_reason = "latest run is a filtered subset"
        elif not last_run.get("runId"):
            run_state_reason = "latest run-state has no runId"
        elif last_run.get("runId") != report.get("runId"):
            run_state_reason = "latest successful report pointer did not advance"
        else:
            run_state_usable = True
    direct_rows = [row for row in report.get("links") or [] if row.get("includeInPriceComparison") is True]
    captured = [
        (row.get("snapshot") or {}).get("capturedAt") or row.get("capturedAt")
        for row in direct_rows
        if row.get("snapshot")
    ]
    times = [parse_time(value) for value in captured]
    valid_times = [value for value in times if value is not None]
    oldest = min(valid_times) if valid_times else None
    oldest_age = round((now - oldest).total_seconds() / 3600, 2) if oldest else None
    completed_age = age_hours(report.get("completedAt") or report.get("startedAt"), now)
    pending = report.get("pendingReconciliation") or {}
    pending_count = int(pending.get("count") or len(pending.get("items") or []))
    reconciliation_errors = report.get("reconciliationErrors") or []
    stale_reasons = []
    if not direct_rows or len(valid_times) != len(direct_rows):
        stale_reasons.append("direct snapshot timestamps are missing or invalid")
    if oldest_age is None or oldest_age > 24:
        stale_reasons.append("oldest direct snapshot is outside the 24h window")
    if any(value > now for value in valid_times):
        stale_reasons.append("future-dated direct snapshot")
    if run_state_reason:
        stale_reasons.append(run_state_reason)
    if completed_age is None or completed_age > 36 or parse_time(report.get("completedAt") or report.get("startedAt")) > now:
        stale_reasons.append("report completion time is missing, future-dated, or stale")
    if pending_count:
        stale_reasons.append("uncertain uploads require reconciliation")
    if reconciliation_errors:
        stale_reasons.append("reconciliation API failed")
    failed = any(failure_counts.values())
    stale = bool(stale_reasons)
    return {
        "dryRun": bool(report.get("dryRun")),
        "fatalError": report.get("fatalError"),
        "filtered": filtered,
        "completedAgeHours": completed_age,
        "oldestDirectCapturedAt": oldest.isoformat().replace("+00:00", "Z") if oldest else None,
        "oldestDirectAgeHours": oldest_age,
        "directSnapshotCount": len(direct_rows),
        "failureCounts": failure_counts,
        "pendingReconciliationCount": pending_count,
        "reconciliationErrors": reconciliation_errors,
        "lastRunId": last_run.get("runId") if last_run else None,
        "lastRunUsable": run_state_usable,
        "lastRunReason": run_state_reason,
        "stale": stale,
        "staleReasons": stale_reasons,
        "usable": run_state_usable and not report.get("dryRun") and not report.get("fatalError") and not filtered and not stale and not failed,
    }
