package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type operationsDetailPosition struct {
	BusinessTime time.Time `json:"businessTime"`
	StableID     string    `json:"stableId"`
}
type operationsDetailReadQuery struct {
	Kind                              string
	Start, End, EpochStart, AsOf      time.Time
	Cursor                            *operationsDetailPosition
	Limit                             int
	HighWatermarks                    map[string]any
	LiveValues                        bool // Interactive detail uses authoritative current values; exports freeze mutable facts.
	ActivityKind                      string
	TargetStart, TargetEnd            time.Time
	RetentionDay                      int
	TimeZone, Stage, Currency, Detail string
}
type operationsDetailRow struct {
	Public   map[string]any
	Position operationsDetailPosition
}
type opsDetailSQL struct{ args []any }

func (s *opsDetailSQL) arg(v any) string {
	if at, ok := v.(time.Time); ok {
		v = at.UTC()
	}
	s.args = append(s.args, v)
	return fmt.Sprintf("$%d", len(s.args))
}
func (s *opsDetailSQL) bound(q operationsDetailReadQuery, key, alias string, fields ...string) string {
	if q.HighWatermarks == nil {
		return "true"
	}
	wm, ok := q.HighWatermarks[key].(map[string]any)
	if !ok {
		return "false"
	}
	cols, vals := []string{}, []string{}
	for i := 0; i < len(fields); i += 2 {
		v, ok := wm[fields[i+1]]
		if !ok || v == nil {
			return "false"
		}
		cols = append(cols, alias+"."+fields[i])
		p := s.arg(v)
		if i == 0 {
			p += "::timestamp"
		}
		vals = append(vals, p)
	}
	return "(" + strings.Join(cols, ",") + ") <= (" + strings.Join(vals, ",") + ")"
}
func (s *opsDetailSQL) span(q operationsDetailReadQuery, column string) string {
	return column + ">=" + s.arg(q.Start) + " AND " + column + "<" + s.arg(q.End) + " AND " + column + ">=" + s.arg(q.EpochStart) + " AND " + column + "<=" + s.arg(q.AsOf)
}

const opsKnownEvents = "('order_created','checkout_ready','payment_confirmed','fulfillment_succeeded','checkout_failed','fulfillment_attempt_failed','fulfillment_failed_terminal','expired')"

// Read safe detail rows from the same source predicates used by aggregates.
// Frozen exports bound ingestion watermarks independently from business time.
func readOperationsDetailRows(ctx context.Context, db operationsDB, q operationsDetailReadQuery) ([]operationsDetailRow, error) {
	if q.Limit < 1 || q.Limit > 10001 || q.Start.After(q.End) || q.AsOf.IsZero() {
		return nil, invalid("运营明细范围无效")
	}
	s := &opsDetailSQL{}
	var source string
	var err error
	switch q.Kind {
	case "users", "cumulative_users", "activity", "cohort", "cohort_export":
		source, err = opsGrowthDetailSQL(s, q)
	case "orders", "fulfilled_orders", "payment_lifecycle", "payment_stage":
		source, err = opsCommercialDetailSQL(s, q)
	case "content":
		source, err = opsContentDetailSQL(s, q)
	default:
		return nil, invalid("运营明细类型无效")
	}
	if err != nil {
		return nil, err
	}
	keyset := "true"
	if q.Cursor != nil {
		keyset = "(business_time,stable_id)<(" + s.arg(q.Cursor.BusinessTime) + "," + s.arg(q.Cursor.StableID) + ")"
	}
	query := "WITH detail_rows AS (" + source + ") SELECT public,business_time,stable_id FROM detail_rows WHERE " + keyset + " ORDER BY business_time DESC,stable_id DESC LIMIT " + s.arg(q.Limit)
	rows, err := db.Query(ctx, query, s.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []operationsDetailRow{}
	for rows.Next() {
		var raw []byte
		var row operationsDetailRow
		if err = rows.Scan(&raw, &row.Position.BusinessTime, &row.Position.StableID); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &row.Public); err != nil {
			return nil, err
		}
		if row.Public["operationCreatedAtMismatch"] == true {
			return nil, errors.New("成功产物与积分操作业务时间不一致")
		}
		delete(row.Public, "operationCreatedAtMismatch")
		if row.Position.BusinessTime.After(q.AsOf) || !row.Position.BusinessTime.Before(q.End) || (q.Kind != "cumulative_users" && row.Position.BusinessTime.Before(q.Start)) {
			return nil, errors.New("运营明细数据库结果超出查询范围")
		}
		row.Public["businessTime"] = operationsISO(row.Position.BusinessTime)
		for _, key := range []string{"createdAt", "fulfilledAt"} {
			if value, ok := row.Public[key].(string); ok {
				t, e := time.Parse("2006-01-02T15:04:05.999999999", value)
				if e != nil {
					t, e = time.Parse(time.RFC3339Nano, value)
				}
				if e != nil {
					return nil, e
				}
				row.Public[key] = operationsISO(t)
			}
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func opsGrowthDetailSQL(s *opsDetailSQL, q operationsDetailReadQuery) (string, error) {
	business := "u.created_at"
	retained := "null::boolean"
	from := `"user" u`
	where := "true"
	if q.Kind != "activity" && q.Kind != "cumulative_users" {
		where = s.span(q, "u.created_at") + " AND " + s.bound(q, "users", "u", "created_at", "createdAt", "id", "id")
	}
	if q.Kind == "cumulative_users" {
		where = "u.created_at<" + s.arg(q.End) + " AND u.created_at<=" + s.arg(q.AsOf) + " AND " + s.bound(q, "users", "u", "created_at", "createdAt", "id", "id")
	}
	if q.Kind == "activity" {
		var activity string
		switch q.ActivityKind {
		case "login":
			activity = "SELECT v.user_id,v.first_visited_at business_time FROM user_web_visit v WHERE " + s.span(q, "v.first_visited_at") + " AND " + s.bound(q, "webVisits", "v", "created_at", "createdAt", "user_id", "userId", "app_date", "appDate")
		case "creation":
			activity = "SELECT o.user_id,o.operation_created_at business_time FROM user_output_usage_event o WHERE " + s.span(q, "o.operation_created_at") + " AND " + s.bound(q, "outputs", "o", "created_at", "createdAt", "output_kind::text", "outputKind", "source_task_id", "sourceTaskId")
		case "payment":
			if q.HighWatermarks == nil || q.LiveValues {
				activity = "SELECT p.user_id,p.fulfilled_at business_time FROM payment_order p WHERE p.purpose IN ('credit_top_up','credit_package') AND p.status='fulfilled' AND " + s.span(q, "p.fulfilled_at") + " AND " + s.bound(q, "paymentOrders", "p", "created_at", "createdAt", "id", "id")
			} else {
				activity = "SELECT p.user_id,min(e.occurred_at) business_time FROM payment_lifecycle_event e JOIN payment_order p ON p.id=e.payment_order_id WHERE p.purpose IN ('credit_top_up','credit_package') AND e.event_type='fulfillment_succeeded' AND " + s.bound(q, "paymentOrders", "p", "created_at", "createdAt", "id", "id") + " AND " + s.bound(q, "paymentLifecycle", "e", "recorded_at", "recordedAt", "id", "id") + " GROUP BY p.id,p.user_id HAVING " + s.span(q, "min(e.occurred_at)")
			}
		default:
			return "", invalid("运营活跃类型无效")
		}
		from = `(SELECT user_id,min(business_time) business_time FROM (` + activity + `) activity GROUP BY user_id) a JOIN "user" u ON u.id=a.user_id`
		business = "a.business_time"
		where = "true"
	}
	if q.Kind == "cohort" || q.Kind == "cohort_export" {
		start, end := "", ""
		if q.Kind == "cohort" {
			start, end = s.arg(q.TargetStart), s.arg(q.TargetEnd)
		}
		if q.Kind == "cohort_export" {
			if q.RetentionDay != 1 && q.RetentionDay != 7 && q.RetentionDay != 30 {
				return "", invalid("留存日无效")
			}
			if _, e := time.LoadLocation(q.TimeZone); e != nil {
				return "", invalid("留存时区无效")
			}
			zone := s.arg(q.TimeZone)
			day := s.arg(q.RetentionDay)
			start = "((((u.created_at AT TIME ZONE 'UTC') AT TIME ZONE " + zone + ")::date+" + day + "::integer)::timestamp AT TIME ZONE " + zone + ") AT TIME ZONE 'UTC'"
			end = "((((u.created_at AT TIME ZONE 'UTC') AT TIME ZONE " + zone + ")::date+" + day + "::integer+1)::timestamp AT TIME ZONE " + zone + ") AT TIME ZONE 'UTC'"
			where += " AND (" + start + ")<=" + s.arg(q.AsOf)
		}
		retained = "EXISTS(SELECT 1 FROM user_output_usage_event o WHERE o.user_id=u.id AND o.operation_created_at >= (" + start + ") AND o.operation_created_at < (" + end + ") AND o.operation_created_at<=" + s.arg(q.AsOf) + " AND " + s.bound(q, "outputs", "o", "created_at", "createdAt", "output_kind::text", "outputKind", "source_task_id", "sourceTaskId") + ")"
	}
	return "SELECT jsonb_build_object('userId',u.id,'name',u.name,'email',u.email,'role',u.role,'banned',COALESCE(u.banned,false),'retained'," + retained + ") public," + business + " business_time,u.id stable_id FROM " + from + " WHERE " + where, nil
}

func opsCommercialDetailSQL(s *opsDetailSQL, q operationsDetailReadQuery) (string, error) {
	from := "payment_order p"
	where := "p.purpose IN ('credit_top_up','credit_package') AND " + s.bound(q, "paymentOrders", "p", "created_at", "createdAt", "id", "id")
	business, stable, event := "p.created_at", "p.id", "null::text"
	status, fulfilled, trade := "p.status::text", "p.fulfilled_at", "p.provider_trade_no"
	prefix := ""
	events := ""
	if (q.HighWatermarks != nil && !q.LiveValues) || q.Kind == "payment_lifecycle" || q.Kind == "payment_stage" {
		events = "SELECT e.* FROM payment_lifecycle_event e WHERE e.event_type IN " + opsKnownEvents + " AND " + s.bound(q, "paymentLifecycle", "e", "recorded_at", "recordedAt", "id", "id")
	}
	if q.HighWatermarks != nil && !q.LiveValues {
		prefix = "WITH frozen_events AS (" + events + "),facts AS (SELECT payment_order_id,(array_agg(event_type::text ORDER BY recorded_at DESC,CASE event_type WHEN 'fulfillment_succeeded' THEN 8 WHEN 'fulfillment_failed_terminal' THEN 7 WHEN 'expired' THEN 6 WHEN 'checkout_failed' THEN 5 WHEN 'fulfillment_attempt_failed' THEN 4 WHEN 'payment_confirmed' THEN 3 WHEN 'checkout_ready' THEN 2 ELSE 1 END DESC,id DESC))[1] latest,min(occurred_at) FILTER(WHERE event_type='fulfillment_succeeded') fulfilled,bool_or(event_type IN ('payment_confirmed','fulfillment_attempt_failed','fulfillment_failed_terminal','fulfillment_succeeded')) provider_reference FROM frozen_events GROUP BY payment_order_id) "
		from += " LEFT JOIN facts f ON f.payment_order_id=p.id"
		status = "CASE f.latest WHEN 'fulfillment_succeeded' THEN 'fulfilled' WHEN 'fulfillment_failed_terminal' THEN 'failed' WHEN 'checkout_failed' THEN 'failed' WHEN 'expired' THEN 'expired' WHEN 'payment_confirmed' THEN 'fulfilling' WHEN 'fulfillment_attempt_failed' THEN 'fulfilling' WHEN 'checkout_ready' THEN 'pending' ELSE 'creating' END"
		fulfilled = "f.fulfilled"
		trade = "CASE WHEN f.provider_reference THEN p.provider_trade_no ELSE null END"
	}
	switch q.Kind {
	case "fulfilled_orders":
		business = fulfilled
		if q.HighWatermarks == nil || q.LiveValues {
			where += " AND (" + status + ")='fulfilled'"
		}
	case "payment_lifecycle":
		from += " JOIN (" + events + ") e ON e.payment_order_id=p.id"
		business, stable, event = "e.occurred_at", "e.id", "e.event_type::text"
	case "payment_stage":
		flags := "SELECT e.payment_order_id,bool_or(e.event_type='order_created') created,bool_or(e.event_type='payment_confirmed') paid,bool_or(e.event_type='fulfillment_succeeded') fulfilled,bool_or(e.event_type IN ('checkout_failed','fulfillment_failed_terminal','expired')) failed,min(e.occurred_at) FILTER(WHERE e.event_type='order_created') created_time,min(e.occurred_at) FILTER(WHERE e.event_type='payment_confirmed') payment_time,min(e.occurred_at) FILTER(WHERE e.event_type='fulfillment_succeeded') fulfillment_time,min(e.occurred_at) FILTER(WHERE e.event_type IN ('checkout_failed','fulfillment_failed_terminal','expired')) failure_time FROM (" + events + ") e WHERE " + s.span(q, "e.occurred_at") + " GROUP BY e.payment_order_id"
		from += " JOIN (" + flags + ") flags ON flags.payment_order_id=p.id"
		event = s.arg(q.Stage) + "::text"
		var predicate string
		switch q.Stage {
		case "created_orders":
			predicate = "flags.created"
			business = "flags.created_time"
		case "pending_orders":
			predicate = "flags.created AND NOT flags.paid AND NOT flags.fulfilled AND NOT flags.failed"
			business = "flags.created_time"
		case "payment_confirmed_orders":
			predicate = "flags.paid"
			business = "flags.payment_time"
		case "paid_not_fulfilled_orders":
			predicate = "flags.paid AND NOT flags.fulfilled AND NOT flags.failed"
			business = "flags.payment_time"
		case "fulfilled_orders":
			predicate = "flags.fulfilled"
			business = "flags.fulfillment_time"
		case "failed_orders":
			predicate = "flags.failed"
			business = "flags.failure_time"
		default:
			return "", invalid("支付阶段无效")
		}
		where += " AND " + predicate
	}
	if q.Currency != "" {
		where += " AND upper(p.currency)=" + s.arg(q.Currency)
	}
	where += " AND " + s.span(q, business)
	return prefix + "SELECT jsonb_build_object('paymentOrderId',p.id,'providerTradeNo'," + trade + ",'userId',p.user_id,'currency',upper(p.currency),'amountMinor',p.amount_minor,'orderStatus'," + status + ",'createdAt',p.created_at,'fulfilledAt'," + fulfilled + ",'eventType'," + event + ") public," + business + " business_time," + stable + " stable_id FROM " + from + " WHERE " + where, nil
}

func opsContentDetailSQL(s *opsDetailSQL, q operationsDetailReadQuery) (string, error) {
	media := "true"
	switch q.Detail {
	case "image_outputs":
		media = "o.output_kind='image'"
	case "video_outputs":
		media = "o.output_kind='video'"
	case "credit_usage":
	default:
		return "", invalid("内容明细类型无效")
	}
	operation := "CASE o.output_kind WHEN 'image' THEN 'image_generation' ELSE 'video_generation' END"
	credit := "cu.net_consumed"
	extra := ""
	if q.HighWatermarks != nil && !q.LiveValues {
		credit = "frozen.net"
		extra = " LEFT JOIN LATERAL(SELECT sum(CASE WHEN ce.contribution_kind='consumption' THEN ce.amount ELSE -ce.amount END) net FROM credit_usage_projection_entry ce WHERE ce.user_id=o.user_id AND ce.operation_type=" + operation + " AND ce.operation_id=o.source_task_id AND ce.operation_created_at=o.operation_created_at AND " + s.bound(q, "creditContributions", "ce", "projected_at", "projectedAt", "transaction_id", "transactionId") + ") frozen ON true"
	}
	return "SELECT jsonb_build_object('taskId',o.source_task_id,'userId',o.user_id,'model',COALESCE(NULLIF(btrim(CASE o.output_kind WHEN 'image' THEN g.model ELSE v.model END),''),'unknown'),'mediaType',o.output_kind,'status','completed','quantity',CASE o.output_kind WHEN 'image' THEN o.image_count ELSE 1 END,'videoSeconds',o.video_seconds,'netCredits',COALESCE(" + credit + ",0),'operationCreatedAtMismatch',cu.operation_id IS NULL AND EXISTS(SELECT 1 FROM credit_usage_operation mismatch WHERE mismatch.user_id=o.user_id AND mismatch.operation_type=" + operation + " AND mismatch.operation_id=o.source_task_id AND mismatch.operation_created_at<>o.operation_created_at)) public,o.operation_created_at business_time,o.output_kind::text||':'||o.source_task_id stable_id FROM user_output_usage_event o LEFT JOIN generation g ON o.output_kind='image' AND g.id=o.source_task_id AND g.user_id=o.user_id LEFT JOIN video_generation v ON o.output_kind='video' AND v.id=o.source_task_id AND v.user_id=o.user_id LEFT JOIN credit_usage_operation cu ON cu.user_id=o.user_id AND cu.operation_type=" + operation + " AND cu.operation_id=o.source_task_id AND cu.operation_created_at=o.operation_created_at" + extra + " WHERE " + s.span(q, "o.operation_created_at") + " AND " + media + " AND " + s.bound(q, "outputs", "o", "created_at", "createdAt", "output_kind::text", "outputKind", "source_task_id", "sourceTaskId"), nil
}
