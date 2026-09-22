package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type mediaSchedulerSelection struct {
	Strategy, GroupID string
	Candidates        int
	StartedAt         time.Time
}

func (b *backend) mediaSchedulingStrategy(ctx context.Context) (string, error) {
	value, err := b.settingString(ctx, "IMAGE_BACKEND_SCHEDULING_STRATEGY", "priority")
	if value != "least_acquired" && value != "least_load" {
		value = "priority"
	}
	return value, err
}

// Identifiers here are fixed SQL fragments, never request input. Keep the same
// stable ordering as the shared scheduling-policy contract.
func mediaSchedulingOrder(strategy string) string {
	health := "(m.status='active' AND m.health_status='healthy') DESC"
	tail := "m.last_acquired_at ASC NULLS FIRST,m.last_used_at ASC NULLS FIRST,m.id"
	switch strategy {
	case "least_acquired":
		return "m.lease_acquired_count,m.priority," + health + "," + tail
	case "least_load":
		return "(SELECT count(*)::numeric/GREATEST(m.concurrency,1) FROM image_backend_member_lease l WHERE l.member_id=m.id AND l.expires_at>now()),m.priority," + health + ",m.lease_acquired_count," + tail
	default:
		return "m.priority," + health + "," + tail
	}
}

func recordMediaSchedulerMetric(ctx context.Context, tx pgx.Tx, kind, outcome, member string, selection mediaSchedulerSelection) error {
	if selection.Strategy == "" {
		selection.Strategy = "priority"
	}
	latency := int64(0)
	if !selection.StartedAt.IsZero() {
		latency = max(int64(0), min(time.Since(selection.StartedAt).Milliseconds(), int64(2147483647)))
	}
	_, err := tx.Exec(ctx, `INSERT INTO image_backend_member_scheduler_metric(id,bucket_started_at,request_kind,strategy,outcome,member_type,member_id,group_id,event_count,candidate_count_total,latency_ms_total)
 VALUES($1,date_trunc('minute',now() AT TIME ZONE 'UTC'),$2,$3,$4,CASE WHEN $5='' THEN NULL ELSE 'api' END,NULLIF($5,''),NULLIF($6,''),1,$7,$8)
 ON CONFLICT ON CONSTRAINT image_backend_member_scheduler_metric_bucket_unique DO UPDATE SET event_count=image_backend_member_scheduler_metric.event_count+1,candidate_count_total=image_backend_member_scheduler_metric.candidate_count_total+excluded.candidate_count_total,latency_ms_total=image_backend_member_scheduler_metric.latency_ms_total+excluded.latency_ms_total,updated_at=now()`, newRequestID(), kind, selection.Strategy, outcome, member, selection.GroupID, max(0, selection.Candidates), latency)
	return err
}

func (b *backend) recordMediaSchedulerRejection(ctx context.Context, kind, outcome string, selection mediaSchedulerSelection) error {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err = recordMediaSchedulerMetric(ctx, tx, kind, outcome, "", selection); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// A durable per-task/member receipt distinguishes a new selection from lease
// renewal, expired-lease recovery, repeated polling and duplicate delivery.
func mediaSchedulerAcquiredTx(ctx context.Context, tx pgx.Tx, kind, taskID, member string, selection *mediaSchedulerSelection, operationKeys ...string) error {
	receiptKey := member
	if len(operationKeys) > 0 && operationKeys[0] != "" {
		receiptKey = operationKeys[0]
	}
	table, predicate := "video_generation", "id=$1"
	if kind == "image" {
		table, predicate = "generation", "id=(SELECT COALESCE(generation_id,generation_ids->>0) FROM image_async_task WHERE id=$1)"
	}
	var strategy, group string
	var prior int
	var acquired bool
	if err := tx.QueryRow(ctx, `SELECT COALESCE(metadata->'goSchedulerAcquired','{}'::json)::jsonb ? $2,(SELECT count(*) FROM jsonb_object_keys(COALESCE(metadata->'goSchedulerAcquired','{}'::json)::jsonb)),COALESCE(metadata#>>'{billingSnapshot,group,id}',metadata#>>'{backendGroupSnapshot,id}',metadata->>'backendGroupId','') FROM `+table+` WHERE `+predicate+` FOR UPDATE`, taskID, receiptKey).Scan(&acquired, &prior, &group); err != nil {
		return err
	}
	if acquired {
		return nil
	}
	s := mediaSchedulerSelection{GroupID: group, Candidates: 1}
	if selection != nil {
		s = *selection
		if s.GroupID == "" {
			s.GroupID = group
		}
	}
	if s.Strategy == "" {
		err := tx.QueryRow(ctx, `SELECT value #>> '{}' FROM system_setting WHERE key='IMAGE_BACKEND_SCHEDULING_STRATEGY'`).Scan(&strategy)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		s.Strategy = strategy
	}
	if s.Strategy != "least_acquired" && s.Strategy != "least_load" {
		s.Strategy = "priority"
	}
	if _, err := tx.Exec(ctx, `UPDATE `+table+` SET metadata=(COALESCE(metadata::jsonb,'{}'::jsonb)||jsonb_build_object('goSchedulerAcquired',COALESCE(metadata->'goSchedulerAcquired','{}'::json)::jsonb||jsonb_build_object($2::text,jsonb_build_object('strategy',$3::text,'groupId',$4::text,'candidates',$5::int,'memberId',$6::text,'acquiredAt',clock_timestamp()))))::json WHERE `+predicate, taskID, receiptKey, s.Strategy, s.GroupID, s.Candidates, member); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE image_backend_member SET lease_acquired_count=lease_acquired_count+1,last_acquired_at=now(),updated_at=now() WHERE id=$1`, member); err != nil {
		return err
	}
	outcome := "acquired"
	if prior > 0 && receiptKey == member {
		outcome = "switched"
	}
	return recordMediaSchedulerMetric(ctx, tx, kind, outcome, member, s)
}

// Platform capacity and user/moderation failures are not provider health
// evidence. Store only a fixed safe message for provider failures.
func mediaFailurePenalizesProvider(cause error) bool {
	var busy *scriptRuntimeUnavailableError
	var ae *apiError
	if cause == nil || errors.As(cause, &busy) || errors.Is(cause, context.Canceled) || errors.Is(cause, context.DeadlineExceeded) || errors.Is(cause, errImageProviderCapacity) || errors.Is(cause, errVideoCapacity) {
		return false
	}
	if errors.As(cause, &ae) {
		return false
	}
	var ie *imageProviderTerminalError
	if errors.As(cause, &ie) && (ie.category == "invalid_request" || ie.category == "moderation") {
		return false
	}
	var ve *videoProviderError
	if errors.As(cause, &ve) && (ve.code == "invalid_request" || ve.code == "content_blocked" || ve.code == "capacity_wait_timeout") {
		return false
	}
	message := cause.Error()
	return classifyGenerationError(&message) == "platform" && !strings.Contains(strings.ToLower(message), "moderation")
}

func mediaSchedulerResultTx(ctx context.Context, tx pgx.Tx, kind, taskID, member string, success bool, cause error, terminal ...bool) error {
	return mediaSchedulerOperationResultTx(ctx, tx, kind, taskID, member, "", success, cause, len(terminal) > 0 && terminal[0])
}

func mediaSchedulerOperationResultTx(ctx context.Context, tx pgx.Tx, kind, taskID, member, receiptKey string, success bool, cause error, terminal bool) error {
	table, predicate := "video_generation", "id=$1"
	if kind == "image" {
		table, predicate = "generation", "id=(SELECT COALESCE(generation_id,generation_ids->>0) FROM image_async_task WHERE id=$1)"
	}
	var selected string
	var duration float64
	var receipt map[string]any
	if err := tx.QueryRow(ctx, `SELECT COALESCE(api_adapter_member_id,''),GREATEST(0,extract(epoch FROM((now() AT TIME ZONE 'UTC')-created_at))*1000),COALESCE(metadata->'goSchedulerAcquired','{}'::json) FROM `+table+` WHERE `+predicate+` FOR UPDATE`, taskID).Scan(&selected, &duration, &receipt); err != nil {
		return err
	}
	if member == "" {
		member = selected
	}
	if member == "" {
		err := tx.QueryRow(ctx, `SELECT member_id FROM image_backend_member_lease WHERE id=$1`, "go-"+kind+":"+taskID).Scan(&member)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	if member == "" {
		return nil
	}
	if receiptKey == "" {
		receiptKey = member
	}
	if _, hasReceipt := receipt[receiptKey]; !hasReceipt {
		return nil
	}
	if entry, ok := receipt[receiptKey].(map[string]any); ok {
		if acquiredAt, err := time.Parse(time.RFC3339Nano, extractString(entry, "acquiredAt")); err == nil {
			duration = max(float64(0), float64(time.Since(acquiredAt).Milliseconds()))
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE `+table+` SET metadata=(COALESCE(metadata::jsonb,'{}'::jsonb)||jsonb_build_object('goSchedulerResults',COALESCE(metadata->'goSchedulerResults','{}'::json)::jsonb||jsonb_build_object($2::text,$3::boolean)))::json WHERE `+predicate+` AND NOT COALESCE(metadata->'goSchedulerResults','{}'::json)::jsonb ? $2`, taskID, receiptKey, success)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	if success {
		_, err = tx.Exec(ctx, `UPDATE image_backend_member SET success_count=success_count+1,success_streak=success_streak+1,fail_streak=0,health_status='healthy',status=CASE WHEN status='limited' THEN 'active' ELSE status END,cooldown_until=CASE WHEN status='limited' THEN NULL ELSE cooldown_until END,error_ewma=error_ewma*0.8,duration_ms_ewma=CASE WHEN duration_ms_ewma IS NULL THEN $2 ELSE duration_ms_ewma*0.8+$2*0.2 END,last_used_at=now(),last_observed_at=now(),last_error=NULL,last_error_at=NULL,updated_at=now() WHERE id=$1`, member, duration)
	} else if mediaFailurePenalizesProvider(cause) {
		_, err = tx.Exec(ctx, `UPDATE image_backend_member SET fail_count=fail_count+1,fail_streak=fail_streak+1,success_streak=0,health_status=CASE WHEN fail_streak+1>=3 THEN 'unhealthy' ELSE 'degraded' END,error_ewma=LEAST(1,error_ewma*0.8+0.2),status=CASE WHEN failure_cooldown_enabled THEN 'limited' ELSE status END,cooldown_until=CASE WHEN failure_cooldown_enabled THEN (now() AT TIME ZONE 'UTC')+interval '60 seconds' ELSE cooldown_until END,last_used_at=now(),last_observed_at=now(),last_error='媒体上游调用失败',last_error_at=now(),updated_at=now() WHERE id=$1`, member)
	} else {
		_, err = tx.Exec(ctx, `UPDATE image_backend_member SET last_used_at=now(),last_observed_at=now(),updated_at=now() WHERE id=$1`, member)
	}
	if err != nil {
		return err
	}
	if !success && terminal {
		s := mediaSchedulerSelection{Strategy: "priority"}
		if entry, ok := receipt[receiptKey].(map[string]any); ok {
			s.Strategy = extractString(entry, "strategy")
			s.GroupID = extractString(entry, "groupId")
			s.Candidates = int(goInt64(entry["candidates"]))
		}
		return recordMediaSchedulerMetric(ctx, tx, kind, "terminal_failure", member, s)
	}
	return nil
}

// Keep provider health independent from optional local postprocessing. This
// transition shares task fencing with output adoption and repair receipts.
func (b *backend) recordImageSchedulerResult(ctx context.Context, taskID, member, receiptKey string, success bool, cause error) error {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err = assertImageRepairClaim(ctx, tx, taskID); err != nil {
		return err
	}
	if err = mediaSchedulerOperationResultTx(ctx, tx, "image", taskID, member, receiptKey, success, cause, !success); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
