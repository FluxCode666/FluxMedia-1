package main

// Usage-log endpoints own the user-scoped credits usage read model.  The Web
// UOL binding calls these endpoints with the Better Auth cookie; no usage-log
// query remains in the Next.js request path.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const usageLogCursorDomain = "fluxmedia:usage-log:cursor:v1"
const usageLogEventRefDomain = "fluxmedia:usage-log:event-ref:v1"
const usageLogFilterDomain = "fluxmedia:usage-log:filters:v1"

var usageLogBase64URL = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type usageLogFilters struct {
	Range        string  `json:"range"`
	BusinessType *string `json:"businessType"`
	Status       *string `json:"status"`
}

type usageLogListInput struct {
	Range        string  `json:"range"`
	BusinessType *string `json:"businessType"`
	Status       *string `json:"status"`
	Cursor       *string `json:"cursor"`
	Limit        int     `json:"limit"`
}

type usageLogCursorPayload struct {
	V       int                   `json:"v"`
	Sub     string                `json:"sub"`
	Filter  string                `json:"filter"`
	AsOf    string                `json:"asOf"`
	SortKey usageLogCursorSortKey `json:"sortKey"`
}

type usageLogCursorSortKey struct {
	EventAt       string `json:"eventAt"`
	EventKindRank int    `json:"eventKindRank"`
	StableID      string `json:"stableId"`
}

type usageLogEventRefPayload struct {
	V            int    `json:"v"`
	Sub          string `json:"sub"`
	EventKind    string `json:"eventKind"`
	BusinessType string `json:"businessType"`
	StableID     string `json:"stableId"`
}

type usageLogListRow struct {
	EventKind       string
	BusinessType    string
	RelatedBusiness *string
	OperationType   string
	FactKind        string
	GenerationMode  *string
	SourceChannel   string
	EventAt         time.Time
	EventKindRank   int
	StableID        string
	Status          string
	RawStatus       *string
	GrossConsumed   float64
	RefundAmount    float64
}

type usageLogRequestDetailRow struct {
	BusinessType  string
	RequestID     string
	SourceChannel string
	Status        string
	RawStatus     *string
	Model         *string
	ActualUsage   *float64
	GrossConsumed float64
	Refunded      float64
	CreatedAt     time.Time
	CompletedAt   *time.Time
	RawError      *string
	HasResource   bool
}

type usageLogRefundDetailRow struct {
	RefundID             string
	OriginalStableID     *string
	OriginalBusinessType *string
	OriginalRequestLabel string
	SourceChannel        string
	Refunded             float64
	CreatedAt            time.Time
	ResourceKind         *string
	ResourceID           *string
}

func (b *backend) registerUsageLogRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/credits/usage-log", b.endpoint(b.handleUsageLogList))
	mux.HandleFunc("POST /api/credits/usage-log/detail", b.endpoint(b.handleUsageLogDetail))
}

func usageLogStringPtr(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func usageLogCanonicalFilters(input usageLogFilters) ([]byte, error) {
	if input.Range == "" {
		input.Range = "7d"
	}
	if input.Range != "7d" && input.Range != "30d" && input.Range != "90d" {
		return nil, errors.New("invalid usage log filters")
	}
	for _, value := range []*string{input.BusinessType, input.Status} {
		if value == nil {
			continue
		}
		if strings.TrimSpace(*value) == "" {
			return nil, errors.New("invalid usage log filters")
		}
	}
	return json.Marshal(struct {
		Range        string  `json:"range"`
		BusinessType *string `json:"businessType"`
		Status       *string `json:"status"`
	}{input.Range, input.BusinessType, input.Status})
}

func usageLogFilterFingerprint(filters usageLogFilters, secret string) (string, error) {
	canonical, err := usageLogCanonicalFilters(filters)
	if err != nil {
		return "", err
	}
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write([]byte(usageLogFilterDomain))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write(canonical)
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil)), nil
}

func usageLogSignPayload(payload, domain, secret string) []byte {
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write([]byte(domain))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(payload))
	return h.Sum(nil)
}

func usageLogEncodeToken(value any, domain, secret string) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	signature := base64.RawURLEncoding.EncodeToString(usageLogSignPayload(payload, domain, secret))
	return payload + "." + signature, nil
}

func usageLogDecodeToken(token, domain, secret string, target any) error {
	if token == "" || len(token) > 4096 {
		return errors.New("invalid usage log token")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 || !usageLogBase64URL.MatchString(parts[0]) || !usageLogBase64URL.MatchString(parts[1]) {
		return errors.New("invalid usage log token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || base64.RawURLEncoding.EncodeToString(payload) != parts[0] {
		return errors.New("invalid usage log token")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || base64.RawURLEncoding.EncodeToString(signature) != parts[1] {
		return errors.New("invalid usage log token")
	}
	expected := usageLogSignPayload(parts[0], domain, secret)
	if !hmac.Equal(signature, expected) {
		return errors.New("invalid usage log token")
	}
	if err := json.Unmarshal(payload, target); err != nil {
		return errors.New("invalid usage log token")
	}
	return nil
}

func usageLogEncodeEventRef(userID, eventKind, businessType, stableID, secret string) (string, error) {
	return usageLogEncodeToken(usageLogEventRefPayload{1, userID, eventKind, businessType, stableID}, usageLogEventRefDomain, secret)
}

func usageLogEncodeCursor(userID string, filters usageLogFilters, asOf time.Time, sortKey usageLogCursorSortKey, secret string) (string, error) {
	fingerprint, err := usageLogFilterFingerprint(filters, secret)
	if err != nil {
		return "", err
	}
	return usageLogEncodeToken(usageLogCursorPayload{1, userID, fingerprint, asOf.UTC().Format(time.RFC3339Nano), sortKey}, usageLogCursorDomain, secret)
}

func usageLogDecodeCursor(token, userID string, filters usageLogFilters, now time.Time, secret string) (usageLogCursorPayload, error) {
	var payload usageLogCursorPayload
	if err := usageLogDecodeToken(token, usageLogCursorDomain, secret, &payload); err != nil {
		return payload, err
	}
	fingerprint, err := usageLogFilterFingerprint(filters, secret)
	if err != nil || payload.V != 1 || payload.Sub != userID || !hmac.Equal([]byte(payload.Filter), []byte(fingerprint)) {
		return payload, errors.New("invalid usage log cursor")
	}
	asOf, err := time.Parse(time.RFC3339Nano, payload.AsOf)
	if err != nil || asOf.After(now) || payload.SortKey.StableID == "" || payload.SortKey.EventAt == "" || payload.SortKey.EventKindRank < 0 || payload.SortKey.EventKindRank > 3 {
		return payload, errors.New("invalid usage log cursor")
	}
	if _, err := time.Parse(time.RFC3339Nano, payload.SortKey.EventAt); err != nil {
		return payload, errors.New("invalid usage log cursor")
	}
	return payload, nil
}

func usageLogParseStableID(stableID string) ([]string, error) {
	var parts []string
	if err := json.Unmarshal([]byte(stableID), &parts); err != nil || len(parts) < 2 {
		return nil, errors.New("invalid stable id")
	}
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			return nil, errors.New("invalid stable id")
		}
	}
	return parts, nil
}

func usageLogStableKindRank(kind string) int {
	switch kind {
	case "generation":
		return 0
	case "operation":
		return 1
	case "refund":
		return 2
	case "video":
		return 3
	default:
		return -1
	}
}

func usageLogNaturalRange(asOf time.Time, loc *time.Location, rangeName string) (time.Time, time.Time, error) {
	days := map[string]int{"7d": 7, "30d": 30, "90d": 90}[rangeName]
	if days == 0 {
		return time.Time{}, time.Time{}, errors.New("invalid usage log range")
	}
	local := asOf.In(loc)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	start := today.AddDate(0, 0, 1-days)
	end := today.AddDate(0, 0, 1)
	return start.UTC(), end.UTC(), nil
}

func (b *backend) requireUsageLogReady(r *http.Request) error {
	var version int
	var status string
	err := b.db.QueryRow(r.Context(), `SELECT version,status FROM analytics_read_model_state WHERE read_model='credit_usage'`).Scan(&version, &status)
	if err != nil && err != pgx.ErrNoRows {
		return err
	}
	if err == pgx.ErrNoRows || version != 1 || status != "ready" {
		return &apiError{http.StatusServiceUnavailable, "NOT_READY", "Usage data is still being prepared"}
	}
	return nil
}

func (b *backend) usageLogUserLocation(r *http.Request, userID string) (*time.Location, error) {
	fallback, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
	if err != nil {
		return nil, err
	}
	loc, _, err := b.userAnalyticsLocation(r, userID, fallback)
	return loc, err
}

func usageLogStableID(kind, primary, secondary string) string {
	raw, _ := json.Marshal(func() []string {
		if secondary == "" {
			return []string{kind, primary}
		}
		return []string{kind, primary, secondary}
	}())
	return string(raw)
}

// The query deliberately mirrors the four source branches in the former
// repository: current image/video requests, retired image requests with a
// financial fact, historical ledger operations, and refunds.  The output is a
// narrow row; prompt/metadata/error text is never returned to the caller.
const usageLogListSQL = `
WITH events AS (
  SELECT 'request'::text AS event_kind, 'image'::text AS business_type,
    NULL::text AS related_business_type,
    CASE WHEN NULLIF(g.metadata->>'externalApiKeyId','') IS NOT NULL THEN 'api'
      WHEN g.usage_log_visible IS TRUE THEN 'web' ELSE 'unknown' END::text AS source_channel,
    'image_generation'::text AS operation_type, 'request'::text AS fact_kind,
    COALESCE(NULLIF(LOWER(BTRIM(g.metadata->>'mode')), ''),'generate')::text AS generation_mode,
    g.created_at AS event_at, 3::int AS event_kind_rank, 'generation'::text AS stable_kind,
    g.id::text AS stable_primary, ''::text AS stable_secondary,
    CASE WHEN g.status='pending' THEN 'processing' WHEN g.status='completed' THEN 'succeeded'
      WHEN g.status='failed' THEN 'failed' ELSE 'unknown' END::text AS status,
    g.status::text AS raw_status, COALESCE(u.gross_consumed,0)::float8 AS gross_consumed,
    0::float8 AS refund_amount
  FROM generation g LEFT JOIN credit_usage_operation u
    ON u.user_id=g.user_id AND u.operation_type='image_generation' AND u.operation_id=g.id
  WHERE g.user_id=$1 AND g.created_at >= $2 AND g.created_at < $3 AND g.created_at <= $4
    AND COALESCE(NULLIF(LOWER(BTRIM(g.metadata->>'mode')), ''),'generate') IN ('generate','edit')
  UNION ALL
  SELECT 'request','historical',NULL,
    CASE WHEN NULLIF(g.metadata->>'externalApiKeyId','') IS NOT NULL THEN 'api'
      WHEN g.usage_log_visible IS TRUE THEN 'web' ELSE 'unknown' END,
    'image_generation','request',COALESCE(NULLIF(LOWER(BTRIM(g.metadata->>'mode')), ''),'generate'),
    g.created_at,1,'generation',g.id::text,'',
    CASE WHEN g.status='pending' THEN 'processing' WHEN g.status='completed' THEN 'succeeded'
      WHEN g.status='failed' THEN 'failed' ELSE 'unknown' END,g.status::text,
    u.gross_consumed::float8,0::float8
  FROM generation g JOIN credit_usage_operation u
    ON u.user_id=g.user_id AND u.operation_type='image_generation' AND u.operation_id=g.id
    AND u.gross_consumed > 0
  WHERE g.user_id=$1 AND g.created_at >= $2 AND g.created_at < $3 AND g.created_at <= $4
    AND COALESCE(NULLIF(LOWER(BTRIM(g.metadata->>'mode')), ''),'generate') NOT IN ('generate','edit')
  UNION ALL
  SELECT 'request','video',NULL,CASE WHEN v.api_key_id IS NULL THEN 'web' ELSE 'api' END,
    'video_generation','request',NULL,v.created_at,2,'video',v.id::text,'',
    CASE WHEN v.status IN ('pending','running') THEN 'processing' WHEN v.status='completed' THEN 'succeeded'
      WHEN v.status='failed' THEN 'failed' ELSE 'unknown' END,v.status::text,
    COALESCE(u.gross_consumed,0)::float8,0::float8
  FROM video_generation v LEFT JOIN credit_usage_operation u
    ON u.user_id=v.user_id AND u.operation_type='video_generation' AND u.operation_id=v.id
  WHERE v.user_id=$1 AND v.created_at >= $2 AND v.created_at < $3 AND v.created_at <= $4
    AND (v.usage_log_visible IS TRUE OR v.api_key_id IS NULL)
  UNION ALL
  SELECT 'request','historical',NULL,'web',u.operation_type,'financial',NULL,
    u.operation_created_at,1,'operation',u.operation_type,u.operation_id,'unknown',NULL,
    u.gross_consumed::float8,0::float8
  FROM credit_usage_operation u
  WHERE u.user_id=$1 AND u.operation_type IN ('manual_consumption','admin_credit_adjustment','uol_credit_consumption')
    AND u.gross_consumed > 0 AND u.operation_created_at >= $2 AND u.operation_created_at < $3
    AND u.operation_created_at <= $4
  UNION ALL
  SELECT 'refund','refund',CASE WHEN g.id IS NOT NULL
      AND COALESCE(NULLIF(LOWER(BTRIM(g.metadata->>'mode')), ''),'generate') IN ('generate','edit') THEN 'image'
      WHEN v.id IS NOT NULL THEN 'video' ELSE 'historical' END,
    CASE WHEN v.api_key_id IS NOT NULL OR NULLIF(g.metadata->>'externalApiKeyId','') IS NOT NULL THEN 'api'
      WHEN v.id IS NOT NULL OR g.usage_log_visible IS TRUE
        OR t.operation_type IN ('manual_consumption','admin_credit_adjustment','uol_credit_consumption') THEN 'web'
      ELSE 'unknown' END,
    t.operation_type,'refund',NULL,t.created_at,0,'refund',t.id::text,'refund',NULL,
    0::float8,t.amount::float8
  FROM credits_transaction t
  LEFT JOIN generation g ON t.operation_type='image_generation' AND g.user_id=t.user_id AND g.id=t.operation_id
  LEFT JOIN video_generation v ON t.operation_type='video_generation' AND v.user_id=t.user_id AND v.id=t.operation_id
    AND (v.usage_log_visible IS TRUE OR v.api_key_id IS NULL)
  WHERE t.user_id=$1 AND t.type='refund' AND t.created_at >= $2 AND t.created_at < $3 AND t.created_at <= $4
    AND (g.id IS NOT NULL OR v.id IS NOT NULL OR t.operation_type IN ('manual_consumption','admin_credit_adjustment','uol_credit_consumption'))
), filtered AS (
  SELECT * FROM events
  WHERE ($5::text IS NULL OR business_type=$5)
    AND ($6::text IS NULL OR status=$6)
    AND ($8::timestamp IS NULL OR event_at < $8 OR (event_at=$8 AND (
      event_kind_rank < $9 OR (event_kind_rank=$9 AND (
        CASE stable_kind WHEN 'generation' THEN 0 WHEN 'operation' THEN 1 WHEN 'refund' THEN 2 WHEN 'video' THEN 3 ELSE -1 END < $10
        OR (CASE stable_kind WHEN 'generation' THEN 0 WHEN 'operation' THEN 1 WHEN 'refund' THEN 2 WHEN 'video' THEN 3 ELSE -1 END = $10
          AND (stable_primary < $11 OR (stable_primary=$11 AND stable_secondary < $12)))
      ))
    )))
)
SELECT event_kind,business_type,related_business_type,operation_type,fact_kind,generation_mode,source_channel,
  event_at,event_kind_rank,stable_kind,stable_primary,stable_secondary,status,raw_status,gross_consumed,refund_amount
FROM filtered
ORDER BY event_at DESC,event_kind_rank DESC,
  CASE stable_kind WHEN 'generation' THEN 0 WHEN 'operation' THEN 1 WHEN 'refund' THEN 2 WHEN 'video' THEN 3 ELSE -1 END DESC,
  stable_primary DESC,stable_secondary DESC
LIMIT $7`

func usageLogStatusValid(value *string) bool {
	if value == nil {
		return true
	}
	switch *value {
	case "processing", "succeeded", "failed", "refund", "unknown":
		return true
	default:
		return false
	}
}

func usageLogBusinessTypeValid(value *string) bool {
	if value == nil {
		return true
	}
	switch *value {
	case "image", "video", "refund", "historical":
		return true
	default:
		return false
	}
}

func usageLogListInputValid(in *usageLogListInput) error {
	if in.Range == "" {
		in.Range = "7d"
	}
	if in.Limit == 0 {
		in.Limit = 20
	}
	if in.Range != "7d" && in.Range != "30d" && in.Range != "90d" {
		return invalid("Invalid usage log range")
	}
	if in.Limit < 1 || in.Limit > 50 || !usageLogBusinessTypeValid(in.BusinessType) || !usageLogStatusValid(in.Status) {
		return invalid("Invalid usage log filter")
	}
	return nil
}

func (b *backend) handleUsageLogList(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	if err = b.requireUsageLogReady(r); err != nil {
		return err
	}
	var in usageLogListInput
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	if err = usageLogListInputValid(&in); err != nil {
		return err
	}
	loc, err := b.usageLogUserLocation(r, s.User.ID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	asOf := now
	var cursorAt any
	var cursorRank any = 0
	var cursorKindRank any = 0
	var cursorPrimary any = ""
	var cursorSecondary any = ""
	if in.Cursor != nil {
		cursor, decodeErr := usageLogDecodeCursor(*in.Cursor, s.User.ID, usageLogFilters{in.Range, in.BusinessType, in.Status}, now, b.config.authSecret)
		if decodeErr != nil {
			return invalid("Invalid usage log cursor")
		}
		asOf, err = time.Parse(time.RFC3339Nano, cursor.AsOf)
		if err != nil {
			return invalid("Invalid usage log cursor")
		}
		cursorTime, parseErr := time.Parse(time.RFC3339Nano, cursor.SortKey.EventAt)
		if parseErr != nil {
			return invalid("Invalid usage log cursor")
		}
		parts, parseErr := usageLogParseStableID(cursor.SortKey.StableID)
		if parseErr != nil || usageLogStableKindRank(parts[0]) < 0 || usageLogStableKindRank(parts[0]) > 3 {
			return invalid("Invalid usage log cursor")
		}
		cursorAt, cursorRank, cursorKindRank, cursorPrimary = cursorTime.UTC(), cursor.SortKey.EventKindRank, usageLogStableKindRank(parts[0]), parts[1]
		if len(parts) > 2 {
			cursorSecondary = parts[2]
		}
	}
	start, end, err := usageLogNaturalRange(asOf, loc, in.Range)
	if err != nil {
		return invalid("Invalid usage log range")
	}
	if in.Cursor != nil {
		cursorTime := cursorAt.(time.Time)
		if cursorTime.After(asOf) || cursorTime.Before(start) || !cursorTime.Before(end) {
			return invalid("Invalid usage log cursor")
		}
	}
	var businessArg, statusArg any
	if in.BusinessType != nil {
		businessArg = *in.BusinessType
	}
	if in.Status != nil {
		statusArg = *in.Status
	}
	rows, err := b.db.Query(r.Context(), usageLogListSQL, s.User.ID, start, end, asOf, businessArg, statusArg, in.Limit+1, cursorAt, cursorRank, cursorKindRank, cursorPrimary, cursorSecondary)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := make([]map[string]any, 0, in.Limit)
	var last usageLogListRow
	hasMore := false
	for rows.Next() {
		var row usageLogListRow
		var stableKind, stablePrimary, stableSecondary string
		if err = rows.Scan(&row.EventKind, &row.BusinessType, &row.RelatedBusiness, &row.OperationType, &row.FactKind, &row.GenerationMode, &row.SourceChannel, &row.EventAt, &row.EventKindRank, &stableKind, &stablePrimary, &stableSecondary, &row.Status, &row.RawStatus, &row.GrossConsumed, &row.RefundAmount); err != nil {
			return err
		}
		row.StableID = usageLogStableID(stableKind, stablePrimary, stableSecondary)
		if len(items) < in.Limit {
			items = append(items, usageLogListEventJSON(s.User.ID, row, b.config.authSecret))
			last = row
		} else {
			hasMore = true
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	var nextCursor any = nil
	if hasMore && len(items) == in.Limit && last.StableID != "" {
		next, encodeErr := usageLogEncodeCursor(s.User.ID, usageLogFilters{in.Range, in.BusinessType, in.Status}, asOf, usageLogCursorSortKey{last.EventAt.UTC().Format(time.RFC3339Nano), last.EventKindRank, last.StableID}, b.config.authSecret)
		if encodeErr != nil {
			return encodeErr
		}
		nextCursor = next
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"asOf": asOf.UTC().Format(time.RFC3339Nano), "events": items, "nextCursor": nextCursor})
	return nil
}

func usageLogListEventJSON(userID string, row usageLogListRow, secret string) map[string]any {
	isRefund := row.EventKind == "refund"
	businessType := row.BusinessType
	amount := row.GrossConsumed
	if isRefund {
		amount = row.RefundAmount
	}
	eventRef, _ := usageLogEncodeEventRef(userID, row.EventKind, businessType, row.StableID, secret)
	summary := "Historical usage"
	if isRefund {
		summary = "Unlinked historical refund"
		if row.RelatedBusiness != nil && *row.RelatedBusiness == "image" {
			summary = "Image generation refund"
		}
		if row.RelatedBusiness != nil && *row.RelatedBusiness == "video" {
			summary = "Video generation refund"
		}
	} else if businessType == "image" {
		summary = "Image generation"
	} else if businessType == "video" {
		summary = "Video generation"
	}
	if isRefund {
		amount = usageLogMaxFloat(amount, 0)
	} else {
		amount = usageLogMaxFloat(amount, 0)
		amount = -amount
	}
	return map[string]any{"kind": row.EventKind, "eventRef": eventRef, "eventAt": row.EventAt.UTC().Format(time.RFC3339Nano), "businessType": businessType, "sourceChannel": row.SourceChannel, "summary": summary, "status": row.Status, "creditsDelta": amount}
}

func usageLogMaxFloat(value, floor float64) float64 {
	if value < floor {
		return floor
	}
	return value
}

func usageLogMapStatus(businessType string, raw *string) string {
	if businessType == "refund" {
		return "refund"
	}
	value := ""
	if raw != nil {
		value = strings.ToLower(strings.TrimSpace(*raw))
	}
	switch value {
	case "pending", "running", "processing":
		return "processing"
	case "completed", "succeeded", "success":
		return "succeeded"
	case "failed", "error":
		return "failed"
	default:
		return "unknown"
	}
}

func usageLogFailureCode(raw *string) any {
	if raw == nil {
		return nil
	}
	value := strings.ToLower(*raw)
	switch {
	case strings.Contains(value, "moderation"), strings.Contains(value, "safety"), strings.Contains(value, "content policy"):
		return "moderation_blocked"
	case strings.Contains(value, "timeout"), strings.Contains(value, "timed out"), strings.Contains(value, "deadline"):
		return "timeout"
	case strings.Contains(value, "unavailable"), strings.Contains(value, "overload"), strings.Contains(value, "rate limit"):
		return "provider_unavailable"
	default:
		return "processing_failed"
	}
}

const usageLogRequestDetailGenerationSQL = `
SELECT $3::text AS business_type,g.id::text AS request_id,
 CASE WHEN NULLIF(g.metadata->>'externalApiKeyId','') IS NOT NULL
   OR EXISTS (SELECT 1 FROM credit_usage_projection_entry p JOIN credits_transaction c ON c.id=p.transaction_id AND c.user_id=p.user_id AND c.type='consumption'
     WHERE p.user_id=$1 AND p.operation_type='image_generation' AND p.operation_id=g.id AND p.contribution_kind='consumption' AND NULLIF(c.metadata->>'externalApiKeyId','') IS NOT NULL)
   THEN 'api' WHEN g.usage_log_visible IS TRUE THEN 'web' ELSE 'unknown' END::text AS source_channel,
 CASE WHEN g.status='pending' THEN 'processing' WHEN g.status='completed' THEN 'succeeded' WHEN g.status='failed' THEN 'failed' ELSE 'unknown' END::text AS status,
 g.status::text AS raw_status,CASE WHEN $3='image' THEN NULLIF(g.model,'') ELSE NULL END::text AS model_or_endpoint,
 CASE WHEN $3='image' THEN o.image_count::float8 ELSE NULL END::float8 AS actual_usage_value,
 COALESCE(u.gross_consumed,0)::float8 AS gross_consumed,COALESCE(u.refunded,0)::float8 AS refunded,
 g.created_at,g.completed_at,CASE WHEN $3='image' THEN g.error ELSE NULL END::text AS raw_error,false AS has_resource
FROM generation g LEFT JOIN credit_usage_operation u ON u.user_id=g.user_id AND u.operation_type='image_generation' AND u.operation_id=g.id
LEFT JOIN user_output_usage_event o ON o.user_id=g.user_id AND o.output_kind='image' AND o.source_task_id=g.id
WHERE g.user_id=$1 AND g.id=$2 AND (($3='image') = (COALESCE(NULLIF(LOWER(BTRIM(g.metadata->>'mode')), ''),'generate') IN ('generate','edit')))
  AND ($3='image' OR COALESCE(u.gross_consumed,0)>0) LIMIT 1`

const usageLogRequestDetailVideoSQL = `
SELECT 'video'::text AS business_type,v.id::text AS request_id,CASE WHEN v.api_key_id IS NULL THEN 'web' ELSE 'api' END::text AS source_channel,
 CASE WHEN v.status IN ('pending','running') THEN 'processing' WHEN v.status='completed' THEN 'succeeded' WHEN v.status='failed' THEN 'failed' ELSE 'unknown' END::text AS status,
 v.status::text AS raw_status,NULLIF(v.model,'')::text AS model_or_endpoint,o.video_seconds::float8 AS actual_usage_value,
 COALESCE(u.gross_consumed,0)::float8 AS gross_consumed,COALESCE(u.refunded,0)::float8 AS refunded,v.created_at,v.completed_at,v.error::text AS raw_error,false AS has_resource
FROM video_generation v LEFT JOIN credit_usage_operation u ON u.user_id=v.user_id AND u.operation_type='video_generation' AND u.operation_id=v.id
LEFT JOIN user_output_usage_event o ON o.user_id=v.user_id AND o.output_kind='video' AND o.source_task_id=v.id
WHERE v.user_id=$1 AND v.id=$2 AND (v.usage_log_visible IS TRUE OR v.api_key_id IS NULL) LIMIT 1`

const usageLogRequestDetailHistoricalSQL = `
SELECT 'historical'::text AS business_type,u.operation_id::text AS request_id,'web'::text AS source_channel,'unknown'::text AS status,
 NULL::text AS raw_status,NULL::text AS model_or_endpoint,NULL::float8 AS actual_usage_value,u.gross_consumed::float8 AS gross_consumed,u.refunded::float8 AS refunded,
 u.operation_created_at AS created_at,NULL::timestamp AS completed_at,NULL::text AS raw_error,false AS has_resource
FROM credit_usage_operation u WHERE u.user_id=$1 AND u.operation_type=$2 AND u.operation_id=$3 AND u.gross_consumed>0 LIMIT 1`

const usageLogRefundDetailSQL = `
SELECT t.id::text AS refund_id,
 CASE WHEN g.id IS NOT NULL THEN json_build_array('generation',g.id)::text WHEN v.id IS NOT NULL THEN json_build_array('video',v.id)::text
   WHEN t.operation_type IN ('manual_consumption','admin_credit_adjustment','uol_credit_consumption') AND u.operation_id IS NOT NULL THEN json_build_array('operation',t.operation_type,t.operation_id)::text ELSE NULL END AS original_stable_id,
 CASE WHEN g.id IS NOT NULL AND COALESCE(NULLIF(LOWER(BTRIM(g.metadata->>'mode')), ''),'generate') IN ('generate','edit') THEN 'image'
   WHEN g.id IS NOT NULL THEN 'historical' WHEN v.id IS NOT NULL THEN 'video'
   WHEN t.operation_type IN ('manual_consumption','admin_credit_adjustment','uol_credit_consumption') AND u.operation_id IS NOT NULL THEN 'historical' ELSE NULL END::text AS original_business_type,
 CASE WHEN g.id IS NOT NULL AND COALESCE(NULLIF(LOWER(BTRIM(g.metadata->>'mode')), ''),'generate') IN ('generate','edit') THEN 'Image generation'
   WHEN g.id IS NOT NULL THEN 'Historical usage' WHEN v.id IS NOT NULL THEN 'Video generation' ELSE 'Unlinked historical refund' END::text AS original_request_label,
 CASE WHEN v.api_key_id IS NOT NULL OR NULLIF(g.metadata->>'externalApiKeyId','') IS NOT NULL
   OR EXISTS (SELECT 1 FROM credit_usage_projection_entry p JOIN credits_transaction c ON c.id=p.transaction_id AND c.user_id=p.user_id AND c.type='consumption'
     WHERE p.user_id=$1 AND p.operation_type=t.operation_type AND p.operation_id=t.operation_id AND p.contribution_kind='consumption' AND NULLIF(c.metadata->>'externalApiKeyId','') IS NOT NULL)
   THEN 'api' WHEN v.id IS NOT NULL OR g.usage_log_visible IS TRUE OR t.operation_type IN ('manual_consumption','admin_credit_adjustment','uol_credit_consumption') THEN 'web' ELSE 'unknown' END::text AS source_channel,
 t.amount::float8 AS refunded,t.created_at,NULL::text AS resource_kind,NULL::text AS resource_id
FROM credits_transaction t LEFT JOIN generation g ON t.operation_type='image_generation' AND g.user_id=t.user_id AND g.id=t.operation_id
LEFT JOIN video_generation v ON t.operation_type='video_generation' AND v.user_id=t.user_id AND v.id=t.operation_id AND (v.usage_log_visible IS TRUE OR v.api_key_id IS NULL)
LEFT JOIN credit_usage_operation u ON u.user_id=t.user_id AND u.operation_type=t.operation_type AND u.operation_id=t.operation_id
WHERE t.user_id=$1 AND t.type='refund' AND t.id=$2
 AND (g.id IS NOT NULL OR v.id IS NOT NULL OR t.operation_type IN ('manual_consumption','admin_credit_adjustment','uol_credit_consumption')) LIMIT 1`

func (b *backend) handleUsageLogDetail(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	if err = b.requireUsageLogReady(r); err != nil {
		return err
	}
	var in struct {
		EventRef string `json:"eventRef"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.EventRef) == "" || len(in.EventRef) > 4096 {
		return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
	}
	var ref usageLogEventRefPayload
	if err = usageLogDecodeToken(in.EventRef, usageLogEventRefDomain, b.config.authSecret, &ref); err != nil || ref.V != 1 || ref.Sub != s.User.ID {
		return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
	}
	if (ref.EventKind == "refund") != (ref.BusinessType == "refund") || (ref.EventKind != "refund" && ref.EventKind != "request") {
		return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
	}
	parts, parseErr := usageLogParseStableID(ref.StableID)
	if parseErr != nil || usageLogStableKindRank(parts[0]) < 0 {
		return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
	}
	noStore(w)
	if ref.EventKind == "refund" {
		if parts[0] != "refund" {
			return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
		}
		var row usageLogRefundDetailRow
		if err = b.db.QueryRow(r.Context(), usageLogRefundDetailSQL, s.User.ID, parts[1]).Scan(&row.RefundID, &row.OriginalStableID, &row.OriginalBusinessType, &row.OriginalRequestLabel, &row.SourceChannel, &row.Refunded, &row.CreatedAt, &row.ResourceKind, &row.ResourceID); err != nil {
			if err == pgx.ErrNoRows {
				return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
			}
			return err
		}
		var originalRef any
		if row.OriginalStableID != nil && row.OriginalBusinessType != nil && *row.OriginalBusinessType != "refund" {
			originalRef, _ = usageLogEncodeEventRef(s.User.ID, "request", *row.OriginalBusinessType, *row.OriginalStableID, b.config.authSecret)
		}
		var resourceRef any
		if row.ResourceKind != nil && row.ResourceID != nil {
			resourceRef = map[string]any{"kind": *row.ResourceKind, "id": *row.ResourceID}
		}
		writeJSON(w, http.StatusOK, map[string]any{"kind": "refund", "refundId": row.RefundID, "originalRequestRef": originalRef, "originalRequestLabel": row.OriginalRequestLabel, "sourceChannel": row.SourceChannel, "refunded": usageLogMaxFloat(row.Refunded, 0), "createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano), "resourceRef": resourceRef})
		return nil
	}
	if len(parts) < 2 || (ref.BusinessType == "image" && parts[0] != "generation") || (ref.BusinessType == "historical" && parts[0] != "generation" && parts[0] != "operation") || (ref.BusinessType == "video" && parts[0] != "video") {
		return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
	}
	var row usageLogRequestDetailRow
	switch parts[0] {
	case "generation":
		if err = b.db.QueryRow(r.Context(), usageLogRequestDetailGenerationSQL, s.User.ID, parts[1], ref.BusinessType).Scan(&row.BusinessType, &row.RequestID, &row.SourceChannel, &row.Status, &row.RawStatus, &row.Model, &row.ActualUsage, &row.GrossConsumed, &row.Refunded, &row.CreatedAt, &row.CompletedAt, &row.RawError, &row.HasResource); err != nil {
			if err == pgx.ErrNoRows {
				return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
			}
			return err
		}
	case "video":
		if err = b.db.QueryRow(r.Context(), usageLogRequestDetailVideoSQL, s.User.ID, parts[1]).Scan(&row.BusinessType, &row.RequestID, &row.SourceChannel, &row.Status, &row.RawStatus, &row.Model, &row.ActualUsage, &row.GrossConsumed, &row.Refunded, &row.CreatedAt, &row.CompletedAt, &row.RawError, &row.HasResource); err != nil {
			if err == pgx.ErrNoRows {
				return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
			}
			return err
		}
	case "operation":
		if ref.BusinessType != "historical" || len(parts) < 3 || (parts[1] != "manual_consumption" && parts[1] != "admin_credit_adjustment" && parts[1] != "uol_credit_consumption") {
			return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
		}
		if err = b.db.QueryRow(r.Context(), usageLogRequestDetailHistoricalSQL, s.User.ID, parts[1], parts[2]).Scan(&row.BusinessType, &row.RequestID, &row.SourceChannel, &row.Status, &row.RawStatus, &row.Model, &row.ActualUsage, &row.GrossConsumed, &row.Refunded, &row.CreatedAt, &row.CompletedAt, &row.RawError, &row.HasResource); err != nil {
			if err == pgx.ErrNoRows {
				return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
			}
			return err
		}
	default:
		return &apiError{http.StatusNotFound, "NOT_FOUND", "Usage event not found"}
	}
	status := usageLogMapStatus(row.BusinessType, row.RawStatus)
	if row.Model != nil && strings.TrimSpace(*row.Model) == "" {
		row.Model = nil
	}
	var actualUsage any
	if row.ActualUsage != nil {
		unit := "images"
		if row.BusinessType == "video" {
			unit = "seconds"
		}
		actualUsage = map[string]any{"unit": unit, "value": usageLogMaxFloat(*row.ActualUsage, 0)}
	}
	var failure any
	if status == "failed" {
		failure = usageLogFailureCode(row.RawError)
	}
	var resourceRef any
	if row.HasResource && (row.BusinessType == "image" || row.BusinessType == "video") {
		resourceRef = map[string]any{"kind": row.BusinessType, "id": row.RequestID}
	}
	var completedAt any
	if row.CompletedAt != nil {
		completedAt = row.CompletedAt.UTC().Format(time.RFC3339Nano)
	}
	writeJSON(w, http.StatusOK, map[string]any{"kind": "request", "requestId": row.RequestID, "businessType": row.BusinessType, "sourceChannel": row.SourceChannel, "status": status, "modelOrEndpoint": row.Model, "actualUsage": actualUsage, "grossConsumed": usageLogMaxFloat(row.GrossConsumed, 0), "refunded": usageLogMaxFloat(row.Refunded, 0), "netConsumed": usageLogMaxFloat(row.GrossConsumed-row.Refunded, 0), "createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano), "completedAt": completedAt, "failureCode": failure, "resourceRef": resourceRef})
	return nil
}
