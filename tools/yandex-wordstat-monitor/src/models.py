from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field

from src import PIPELINE_VERSION


FreshnessStatus = Literal["fresh", "lagging_notice", "lagging_significant", "stale_expired", "no_data"]
GovernanceDisposition = Literal[
    "eligible_observation",
    "blocked_terminated_direction",
    "excluded_existing_portfolio",
    "filtered_non_purchase_noise",
    "expansion_candidate_only",
]
VolumeBandStatus = Literal[
    "below_observation_band",
    "within_observation_band",
    "above_observation_band",
    "unknown_volume",
]


class WordstatTopItem(BaseModel):
    phrase: str
    count: int


class WordstatTopResponseNormalized(BaseModel):
    phrase: str
    totalCount: Optional[int] = None
    results: List[WordstatTopItem] = Field(default_factory=list)
    associations: List[WordstatTopItem] = Field(default_factory=list)


class WordstatDynamicsPoint(BaseModel):
    date: str
    count: int
    share: Optional[float] = None


class WordstatDynamicsResponseNormalized(BaseModel):
    phrase: str
    caliber: Literal["weekly_plus_only", "monthly_plus_only", "daily_strict_operator"]
    period: Literal["weekly", "monthly", "daily"]
    operatorMode: str
    regions: List[int]
    devices: List[str]
    fromDate: str
    toDate: str
    capturedAt: str
    sourceAsOf: Optional[str] = None
    returnedPointsCount: int = 0
    hasTrailingGap: bool = False
    hasInternalGap: bool = False
    results: List[WordstatDynamicsPoint] = Field(default_factory=list)


class WordstatRegionItem(BaseModel):
    region: int
    cityNameRu: Optional[str] = None
    cityNameZh: Optional[str] = None
    count: int
    share: Optional[float] = None
    affinityIndex: Optional[float] = None


class WordstatRegionsResponseNormalized(BaseModel):
    phrase: str
    regionType: Literal["cities", "regions", "all"]
    devices: List[str]
    capturedAt: str
    results: List[WordstatRegionItem] = Field(default_factory=list)


class RawReceiptEnvelope(BaseModel):
    schemaVersion: str
    algoVersion: str
    runId: str
    endpoint: Literal["topRequests", "dynamics", "regions"]
    cacheFingerprint: str
    requestPayload: Dict[str, Any]
    rawResponse: Dict[str, Any]
    capturedAt: str
    sourceAsOf: Optional[str] = None
    rawPayloadSha256: str


class EventLedgerRecord(BaseModel):
    eventId: str
    runId: str
    isoWeek: str
    status: Literal["IN_PROGRESS", "COMPLETED", "FAILED", "HALTED_OUTCOME_UNKNOWN"]
    updatedAt: str
    reportStorageKey: Optional[str] = None
    reportSha256: Optional[str] = None
    notes: List[str] = Field(default_factory=list)


class ReferenceCityMetric(BaseModel):
    regionId: int
    nameRu: str
    nameZh: str
    count: Optional[int] = None
    rawShare: Optional[float] = None
    affinityIndex: Optional[float] = None
    shareDenominatorNote: str = "Wordstat接口原始share字段，仅保留原值；未经明确分母与归一化，不得命名为核心城市占比"


class ScoreBreakdown(BaseModel):
    observationPriorityScore: Optional[float] = None
    scoreStatus: Literal[
        "scored_full",
        "scored_partial_reweighted",
        "insufficient_data",
        "stale_hold",
        "not_applicable_blocked",
    ]
    trendScore: Optional[float] = None
    cityAffinityScore: Optional[float] = None
    stabilityScore: Optional[float] = None
    freshnessFactor: float = 0.0
    sampleConfidenceFactor: float = 0.0
    singleMetricDominanceCapped: bool = False
    explanation: List[str] = Field(default_factory=list)


class SeasonalityHint(BaseModel):
    status: Literal[
        "upcoming_peak_window",
        "outside_60_90d_window",
        "insufficient_yoy_history",
        "stale_or_missing_series",
    ]
    estimatedWeeksToPeak: Optional[int] = None
    estimatedDaysBand: Optional[List[int]] = None
    historicalPeakWeekStart: Optional[str] = None
    historicalPeakCount: Optional[int] = None
    basisSourceAsOf: Optional[str] = None
    uncertaintyNote: str
    allowedPreparationActions: List[str] = Field(default_factory=list)
    prohibitedActions: List[str] = Field(default_factory=list)


class DailyGapFill(BaseModel):
    status: Literal["not_needed", "complete", "partial", "no_data", "request_failed", "no_weekly_baseline"]
    requestedFromDate: Optional[str] = None
    requestedToDate: Optional[str] = None
    targetThroughDate: Optional[str] = None
    sourceAsOf: Optional[str] = None
    coveredThroughDate: Optional[str] = None
    missingFromDate: Optional[str] = None
    missingCalendarDays: Optional[int] = None
    returnedPointsCount: int = 0
    lastCheckedAt: Optional[str] = None
    requestFailed: bool = False
    points: List[WordstatDynamicsPoint] = Field(default_factory=list)
    note: str


class KeywordObservation(BaseModel):
    phrase: str
    zhDraft: str
    zhDraftDisclaimer: str = "机翻/词典辅助阅读草稿，严禁直接作为商品参数或最终俄语上线文案"
    category: str
    seedStatus: str
    conceptClusterId: str
    mergedVariants: List[str] = Field(default_factory=list)
    disposition: GovernanceDisposition
    dispositionReason: Optional[str] = None
    purchaseIntentStatus: Literal["commercial_plausible", "mixed_needs_seller_verify", "non_commercial_noise"]
    brandRiskFlags: List[str] = Field(default_factory=list)
    brandLegalNote: Optional[str] = None
    caliber: str
    requestedFromDate: str
    requestedToDate: str
    sourceAsOf: Optional[str] = None
    lagDaysFromRun: Optional[int] = None
    freshnessStatus: FreshnessStatus
    effectiveWeeklyVolume: Optional[int] = None
    median4wVolume: Optional[float] = None
    volumeBandStatus: VolumeBandStatus
    wowRate: Optional[float] = None
    shortBaselineGrowthRate: Optional[float] = None
    referenceCities: List[ReferenceCityMetric] = Field(default_factory=list)
    weightedReferenceAffinity: Optional[float] = None
    expansionAssociations: List[WordstatTopItem] = Field(default_factory=list)
    score: ScoreBreakdown
    seasonality: SeasonalityHint
    yandexSearchUrl: str
    ozonSearchUrl: str
    warnings: List[str] = Field(default_factory=list)
    dailyGapFill: Optional[DailyGapFill] = None


class SellerValidationContext(BaseModel):
    nativeWindowDays: int
    nativeBatchPages: int
    nativeBatchRows: int
    selfBuiltAccumulatedDays: int
    selfBuiltTargetDays: int
    selfBuiltProgressLabel: str
    promoAutoDecision: bool
    mandatoryHumanGates: List[str]


class FailedRequestDiagnostic(BaseModel):
    phrase: str
    endpoint: str
    errorType: Literal["RATE_LIMIT_429", "UNAVAILABLE_503", "PERMISSION_403", "OUTCOME_UNKNOWN", "BUDGET_EXHAUSTED", "OTHER_HTTP_ERROR"]
    httpStatus: Optional[int] = None
    stage: Literal["primary", "daily_gap", "watermark"] = "primary"
    message: str
    occurredAt: str


class WeeklyObservationReport(BaseModel):
    schemaVersion: str
    algoVersion: str
    pipelineVersion: str = PIPELINE_VERSION
    reportId: str
    idempotencyKey: str
    eventId: str
    isoWeek: str
    runDate: str
    generatedAt: str
    overallStatus: Literal["success", "degraded_partial", "failed_alert_only"]
    globalSourceAsOfMax: Optional[str] = None
    globalSourceAsOfMin: Optional[str] = None
    latestDailySourceAsOf: Optional[str] = None
    budgetUsedToday: int
    budgetLimitDaily: int
    top10Observations: List[KeywordObservation] = Field(default_factory=list)
    allEvaluatedObservations: List[KeywordObservation] = Field(default_factory=list)
    blockedOrExcludedItems: List[KeywordObservation] = Field(default_factory=list)
    failedRequests: List[FailedRequestDiagnostic] = Field(default_factory=list)
    rawReceiptKeys: List[str] = Field(default_factory=list)
    sellerValidationContext: SellerValidationContext
    disclaimers: List[str] = Field(default_factory=list)


class OnzoIngestEnvelope(BaseModel):
    schemaVersion: str
    idempotencyKey: str
    reportStorageKey: str
    reportSha256: str
    reportByteLength: int
    report: WeeklyObservationReport
    feishuCardPayload: Dict[str, Any]
    isAlertCard: bool
