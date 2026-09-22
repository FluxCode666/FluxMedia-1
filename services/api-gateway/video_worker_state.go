package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var errVideoClaimLost = errors.New("video task claim lost")
var errVideoCapacity = errors.New("video provider capacity temporarily unavailable")

type videoWorkerTask struct {
	id, userID, keyID, model, prompt, ratio, resolution, stage      string
	token, memberID, versionID, jobID, videoURL, bucket, storageKey string
	duration, queryFailures                                         int
	metadata, manifest                                              map[string]any
}

func (w *mediaWorker) loadVideoWorkerTask(ctx context.Context, id string) (videoWorkerTask, error) {
	t := videoWorkerTask{id: id}
	var metadata, manifest []byte
	err := w.backend.db.QueryRow(ctx, `SELECT user_id,COALESCE(api_key_id,''),model,prompt,duration_seconds,aspect_ratio,resolution,stage,COALESCE(claim_token,''),COALESCE(api_adapter_member_id,''),COALESCE(api_adapter_version_id,''),COALESCE(upstream_operation_name,upstream_job_id,''),COALESCE(video_url,''),COALESCE(storage_bucket,''),COALESCE(storage_key,''),api_adapter_query_failure_count,COALESCE(metadata,'{}'::json),COALESCE(input_manifest,'{}'::json) FROM video_generation WHERE id=$1`, id).Scan(&t.userID, &t.keyID, &t.model, &t.prompt, &t.duration, &t.ratio, &t.resolution, &t.stage, &t.token, &t.memberID, &t.versionID, &t.jobID, &t.videoURL, &t.bucket, &t.storageKey, &t.queryFailures, &metadata, &manifest)
	if err != nil {
		return t, err
	}
	if json.Unmarshal(metadata, &t.metadata) != nil || json.Unmarshal(manifest, &t.manifest) != nil {
		return t, errors.New("invalid video task snapshot")
	}
	if t.metadata == nil {
		t.metadata = map[string]any{}
	}
	if t.manifest == nil {
		t.manifest = map[string]any{}
	}
	return t, nil
}

// A session lock covers provider I/O as well as DB changes. Claims are renewed
// while that lock is held, and each transition also checks its fencing token.
// A second Go replica can never POST this task while the first is still alive.
func (w *mediaWorker) processDurableVideo(parent context.Context, id string) error {
	b := w.backend
	connection, err := b.db.Acquire(parent)
	if err != nil {
		return err
	}
	defer connection.Release()
	var locked bool
	lockKey := "video-execute:" + id
	if err = connection.QueryRow(parent, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, lockKey).Scan(&locked); err != nil || !locked {
		return err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = connection.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, lockKey)
	}()
	t, err := w.loadVideoWorkerTask(parent, id)
	if err != nil {
		return err
	}
	if t.stage == "completed" {
		return nil
	}
	if t.stage == "failed" {
		var credits float64
		if err = b.db.QueryRow(parent, `SELECT credits_consumed FROM video_generation WHERE id=$1`, id).Scan(&credits); err != nil || credits == 0 {
			return err
		}
	}
	// The session lock is the only execution entry point, including direct
	// recovery calls. Replacing a claim here is safe even when a queued claim was
	// acquired before a previous worker released this lock.
	t.token = newWorkerToken()
	if _, err = b.db.Exec(parent, `UPDATE video_generation SET claim_token=$2,claim_expires_at=now()+$3::interval WHERE id=$1 AND stage<>'completed'`, id, t.token, mediaWorkerClaimTTL.String()); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				tag, err := b.db.Exec(ctx, `UPDATE video_generation SET claim_expires_at=now()+$3::interval WHERE id=$1 AND claim_token=$2 AND claim_expires_at>now()`, id, t.token, mediaWorkerClaimTTL.String())
				if err != nil || tag.RowsAffected() != 1 {
					cancel()
					return
				}
				_, err = b.db.Exec(ctx, `UPDATE image_backend_member_lease SET expires_at=now()+$3::interval,updated_at=now() WHERE id=$1 AND owner_token=$2`, videoWorkerLeaseID(id), t.token, mediaWorkerClaimTTL.String())
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	err = w.executeVideoState(ctx, &t)
	cancel()
	<-done
	cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	// On unexpected infrastructure failure, preserve the stage and schedule
	// durable recovery. Accepted tasks keep their provider lease while polling.
	_, releaseErr := b.db.Exec(cleanup, `UPDATE video_generation SET claim_token=NULL,claim_expires_at=NULL,next_poll_at=CASE WHEN stage IN ('completed','failed') THEN NULL ELSE COALESCE(next_poll_at,now()+interval '5 seconds') END WHERE id=$1 AND claim_token=$2`, id, t.token)
	if err != nil {
		return err
	}
	return releaseErr
}

func (w *mediaWorker) videoCAS(ctx context.Context, t *videoWorkerTask, set string, args ...any) error {
	params := []any{t.id, t.token, t.stage}
	params = append(params, args...)
	tag, err := w.backend.db.Exec(ctx, `UPDATE video_generation SET `+set+`,state_version=state_version+1,updated_at=now() WHERE id=$1 AND claim_token=$2 AND stage=$3 AND claim_expires_at>now()`, params...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errVideoClaimLost
	}
	return nil
}

func videoCASTx(ctx context.Context, tx pgx.Tx, t *videoWorkerTask, set string, args ...any) error {
	params := append([]any{t.id, t.token, t.stage}, args...)
	tag, err := tx.Exec(ctx, `UPDATE video_generation SET `+set+`,state_version=state_version+1,updated_at=now() WHERE id=$1 AND claim_token=$2 AND stage=$3 AND claim_expires_at>now()`, params...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errVideoClaimLost
	}
	return nil
}

func (w *mediaWorker) executeVideoState(ctx context.Context, t *videoWorkerTask) error {
	if t.stage == "refunding" || t.stage == "failed" {
		return w.refundVideoTask(ctx, t.id, "视频任务失败退款")
	}
	if t.stage == "created" {
		if err := w.backend.chargeVideoTask(ctx, t.id); err != nil {
			var ae *apiError
			if errors.As(err, &ae) {
				return w.failClaimedVideo(ctx, t, err)
			}
			return err
		}
		t.stage = "charged"
	}
	if t.stage == "downloading" {
		if t.memberID != "" && t.versionID != "" {
			if err := w.acquireVideoMemberLease(ctx, t, providerConfig{memberID: t.memberID, versionID: t.versionID}); err != nil {
				if errors.Is(err, errVideoCapacity) {
					return w.videoWait(ctx, t, 5, nil)
				}
				return err
			}
		}
		return w.downloadClaimedVideo(ctx, t)
	}
	if t.stage == "submitting" || t.stage == "submit_uncertain" {
		if t.memberID == "" || t.versionID == "" {
			return w.failClaimedVideo(ctx, t, errors.New("interrupted video has no fixed provider identity"))
		}
		cfg, err := w.backend.videoProviderForTask(ctx, t.memberID, t.versionID)
		if err != nil {
			return err
		}
		// A durable attempt existed before the POST. Recovery consumes its
		// failure before scheduling a bounded retry with the same idempotency key.
		return w.retryVideoSubmission(ctx, t, cfg, &videoProviderError{code: "network_error", transient: true})
	}
	if t.stage == "polling" {
		if t.memberID == "" || t.versionID == "" || t.jobID == "" {
			return w.failClaimedVideo(ctx, t, errors.New("accepted video missing immutable provider identity"))
		}
		cfg, err := w.backend.videoProviderForTask(ctx, t.memberID, t.versionID)
		if err != nil {
			return w.retryVideoQuery(ctx, t, err)
		}
		if err = w.acquireVideoMemberLease(ctx, t, cfg); err != nil {
			if errors.Is(err, errVideoCapacity) {
				return w.videoWait(ctx, t, 5, nil)
			}
			return err
		}
		// The upstream response never controls the query destination. Build it
		// every time from the accepted adapter version and accepted task ID.
		target, err := videoProviderURL(cfg, "videos.query", t.jobID)
		if err != nil {
			return w.retryVideoQuery(ctx, t, err)
		}
		out, err := w.backend.queryProvider(ctx, cfg, target.String(), t.jobID, t.model)
		if err != nil {
			return w.retryVideoQuery(ctx, t, err)
		}
		videoURL, _, err := inspectVideoProviderResult(cfg, out, t.jobID)
		if err != nil {
			return w.retryVideoQuery(ctx, t, err)
		}
		if videoURL == "" {
			return w.videoCAS(ctx, t, `next_poll_at=now()+$4::interval,error=NULL,api_adapter_query_failure_count=0`, videoPollDelay(out).String())
		}
		return w.acceptVideoDownload(ctx, t, videoURL)
	}
	if t.stage != "charged" && t.stage != "retrying" {
		return errors.New("invalid video worker stage")
	}
	cfg, err := w.selectVideoProvider(ctx, t)
	if err != nil {
		if errors.Is(err, errVideoCapacity) {
			return w.videoCapacityWait(ctx, t)
		}
		var ae *apiError
		if errors.As(err, &ae) {
			return w.failClaimedVideo(ctx, t, err)
		}
		return err
	}
	moderate := cfg.contentSafetyEnabled
	if flag, ok := t.metadata["moderationEnabled"].(bool); ok {
		moderate = flag
	}
	if previous, ok := t.metadata["moderation"].(map[string]any); ok && previous["completed"] == true {
		moderate = false
	}
	if moderate {
		body := map[string]any{"prompt": t.prompt}
		for key, value := range t.manifest {
			body[key] = value
		}
		if err = w.backend.moderateGeneration(ctx, t.userID, t.id, "video_generation", body); err != nil {
			return w.failClaimedVideo(ctx, t, err)
		}
	}
	body, err := w.backend.prepareVideoProviderInput(ctx, cfg, t.id, t.userID, t.model, t.prompt, t.ratio, t.resolution, t.duration, t.metadata, t.manifest)
	if err != nil {
		return w.failClaimedVideo(ctx, t, err)
	}
	ctx = context.WithValue(ctx, videoBeforeSendContextKey{}, func() error { return w.startVideoSubmission(ctx, t, cfg) })
	ctx = context.WithValue(ctx, videoSnapshotContextKey{}, func(snapshot map[string]any) error {
		return w.videoCAS(ctx, t, `metadata=(COALESCE(metadata::jsonb,'{}'::jsonb)||$4::jsonb)::json`, mustJSON(map[string]any{"upstreamRequestSnapshot": snapshot}))
	})
	out, err := w.backend.callProvider(ctx, cfg, "videos.generate", body, t.id, t.model)
	if err != nil {
		if t.stage != "submitting" {
			var busy *scriptRuntimeUnavailableError
			if errors.As(err, &busy) {
				delay := busy.retryAfterSeconds
				if delay < 5 {
					delay = 5
				}
				return w.videoWait(ctx, t, delay, err)
			}
			if errors.Is(err, errVideoClaimLost) || ctx.Err() != nil {
				return err
			}
			// Request preparation failed before I/O; record the failed adapter
			// attempt so failover cannot select the same incompatible version.
			if startErr := w.startVideoSubmission(ctx, t, cfg); startErr != nil {
				return startErr
			}
			var failure *videoProviderError
			if !errors.As(err, &failure) {
				err = &videoProviderError{code: "unknown_submission_failure", switchMember: true}
			}
		}
		return w.retryVideoSubmission(ctx, t, cfg, err)
	}
	videoURL, accepted, err := inspectVideoProviderResult(cfg, out, "")
	if err != nil {
		return w.retryVideoSubmission(ctx, t, cfg, err)
	}
	if videoURL != "" {
		return w.acceptVideoDownload(ctx, t, videoURL)
	}
	target, err := videoProviderURL(cfg, "videos.query", accepted)
	if err != nil {
		return w.failClaimedVideo(ctx, t, err)
	}
	var operationName any
	if extractString(cfg.adapter, "videoProtocolMode") == "gemini" {
		operationName = accepted
	}
	if err = w.videoCAS(ctx, t, `stage='polling',status='running',upstream_job_id=$4,upstream_operation_name=$5,poll_url=$6,upstream_accepted_at=now(),next_poll_at=now()+$7::interval,submit_started_at=NULL,error=NULL,api_adapter_query_failure_count=0`, accepted, operationName, target.String(), videoPollDelay(out).String()); err != nil {
		return err
	}
	t.stage, t.jobID = "polling", accepted
	return nil
}

func videoWorkerLeaseID(id string) string { return "go-video:" + id }

func (w *mediaWorker) acquireVideoMemberLease(ctx context.Context, t *videoWorkerTask, cfg providerConfig) error {
	tx, err := w.backend.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	var valid bool
	if err = tx.QueryRow(ctx, `SELECT claim_token=$2 AND claim_expires_at>now() AND stage NOT IN ('completed','failed') FROM video_generation WHERE id=$1 FOR UPDATE`, t.id, t.token).Scan(&valid); err != nil {
		return err
	}
	if t.token == "" || !valid {
		return errVideoClaimLost
	}
	var capacity int
	if err = tx.QueryRow(ctx, `SELECT concurrency FROM image_backend_member WHERE id=$1 FOR UPDATE`, cfg.memberID).Scan(&capacity); err != nil {
		return err
	}
	var used int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM image_backend_member_lease WHERE member_id=$1 AND id<>$2 AND expires_at>now()`, cfg.memberID, videoWorkerLeaseID(t.id)).Scan(&used); err != nil {
		return err
	}
	if capacity <= used {
		return errVideoCapacity
	}
	_, err = tx.Exec(ctx, `INSERT INTO image_backend_member_lease(id,member_id,owner_token,api_adapter_member_id,api_adapter_version_id,expires_at) VALUES($1,$2,$3,$2,$4,now()+$5::interval) ON CONFLICT(id) DO UPDATE SET member_id=excluded.member_id,owner_token=excluded.owner_token,api_adapter_member_id=excluded.api_adapter_member_id,api_adapter_version_id=excluded.api_adapter_version_id,expires_at=excluded.expires_at,updated_at=now()`, videoWorkerLeaseID(t.id), cfg.memberID, t.token, cfg.versionID, mediaWorkerClaimTTL.String())
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE video_generation SET member_lease_id=$3,member_lease_owner_token=$2 WHERE id=$1 AND claim_token=$2`, t.id, t.token, videoWorkerLeaseID(t.id))
	if err != nil {
		return err
	}
	if err = mediaSchedulerAcquiredTx(ctx, tx, "video", t.id, cfg.memberID, cfg.scheduler); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (w *mediaWorker) selectVideoProvider(ctx context.Context, t *videoWorkerTask) (providerConfig, error) {
	startedAt := time.Now()
	if t.stage == "retrying" && t.memberID != "" && t.versionID != "" {
		cfg, err := w.backend.videoProviderForTask(ctx, t.memberID, t.versionID)
		if err != nil {
			return cfg, err
		}
		return cfg, w.acquireVideoMemberLease(ctx, t, cfg)
	}
	group := imageGroupSnapshot{}
	if snapshot, ok := t.metadata["backendGroupSnapshot"].(map[string]any); ok {
		_ = json.Unmarshal([]byte(mustJSON(snapshot)), &group)
	}
	if group.ID == "" {
		group.ID = extractString(t.metadata, "backendGroupId")
	}
	if group.ID == "" {
		var err error
		group, err = w.backend.resolveImageGroup(ctx, &apiPrincipal{UserID: t.userID, KeyID: t.keyID}, "")
		if err != nil {
			return providerConfig{}, err
		}
	}
	requiresSafety, hasSafety := t.metadata["moderationEnabled"].(bool)
	if !hasSafety {
		enabled, err := w.backend.settingBool(ctx, "CONTENT_MODERATION_ENABLED", true)
		if err != nil {
			return providerConfig{}, err
		}
		requiresSafety = enabled && (group.ContentSafetyEnabled == nil || *group.ContentSafetyEnabled)
	}
	groupIDs, err := reachableMediaGroupIDs(ctx, w.backend.db, group.ID)
	if err != nil {
		return providerConfig{}, err
	}
	strategy, err := w.backend.mediaSchedulingStrategy(ctx)
	if err != nil {
		return providerConfig{}, err
	}
	rows, err := w.backend.db.Query(ctx, `SELECT m.id FROM image_backend_member m WHERE EXISTS(SELECT 1 FROM image_backend_member_group g WHERE g.member_id=m.id AND g.group_id=ANY($1::text[])) AND m.type='api' AND m.is_enabled AND m.status<>'error' AND (m.cooldown_until IS NULL OR m.cooldown_until<=now()) AND NOT EXISTS(SELECT 1 FROM video_generation_submission_attempt a WHERE a.video_generation_id=$2 AND a.backend_member_id=m.id) ORDER BY `+mediaSchedulingOrder(strategy), groupIDs, t.id)
	if err != nil {
		return providerConfig{}, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return providerConfig{}, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return providerConfig{}, err
	}
	busy := false
	eligible := []providerConfig{}
	for _, id := range ids {
		cfg, err := w.backend.pickImageProvider(ctx, t.model, group, id, requiresSafety)
		if err != nil {
			var ae *apiError
			if errors.As(err, &ae) {
				continue
			}
			return cfg, err
		}
		if !videoProviderSupportsInputs(cfg, t.model, t.manifest) {
			continue
		}
		if _, supported := cfg.operations["videos.generate"]; !supported {
			continue
		}
		eligible = append(eligible, cfg)
	}
	selection := mediaSchedulerSelection{Strategy: strategy, GroupID: group.ID, Candidates: len(eligible), StartedAt: startedAt}
	for _, cfg := range eligible {
		cfg.scheduler = &selection
		if err = w.acquireVideoMemberLease(ctx, t, cfg); errors.Is(err, errVideoCapacity) {
			busy = true
			continue
		} else if err != nil {
			return cfg, err
		}
		cfg.contentSafetyEnabled = requiresSafety
		return cfg, nil
	}
	if busy {
		if err = w.backend.recordMediaSchedulerRejection(ctx, "video", "capacity_rejected", selection); err != nil {
			return providerConfig{}, err
		}
		return providerConfig{}, errVideoCapacity
	}
	if err = w.backend.recordMediaSchedulerRejection(ctx, "video", "no_candidate", selection); err != nil {
		return providerConfig{}, err
	}
	return providerConfig{}, &apiError{503, "NO_ELIGIBLE_MEDIA_PROVIDER", "已授权分组中没有可用的视频供应商"}
}

func videoProviderSupportsInputs(cfg providerConfig, model string, manifest map[string]any) bool {
	capabilities, _ := cfg.adapter["videoInputCapabilitiesByModel"].(map[string]any)
	selected, _ := cfg.adapter["videoInputCapabilities"].(map[string]any)
	for name, value := range capabilities {
		if strings.EqualFold(strings.TrimSpace(name), strings.TrimSpace(model)) {
			selected, _ = value.(map[string]any)
			break
		}
	}
	for _, field := range []string{"referenceVideos", "referenceAudios"} {
		if values, ok := manifest[field].([]any); ok && len(values) > 0 && selected[field] != true {
			return false
		}
	}
	return true
}

func (w *mediaWorker) startVideoSubmission(ctx context.Context, t *videoWorkerTask, cfg providerConfig) error {
	tx, err := w.backend.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	var current string
	if err = tx.QueryRow(ctx, `SELECT stage FROM video_generation WHERE id=$1 AND claim_token=$2 AND claim_expires_at>now() FOR UPDATE`, t.id, t.token).Scan(&current); err != nil {
		return err
	}
	if current != t.stage {
		return errVideoClaimLost
	}
	retries := int(goInt64(cfg.adapter["videoSubmissionRetryCount"]))
	if _, ok := cfg.adapter["videoSubmissionRetryCount"]; !ok {
		retries = 2
	}
	if retries < 0 || retries > 10 {
		return errors.New("invalid video submission retry budget")
	}
	var count, global int
	var snapshot *int
	if err = tx.QueryRow(ctx, `SELECT count(*) FILTER(WHERE backend_member_id=$2),count(*),max(retry_count_snapshot) FILTER(WHERE backend_member_id=$2) FROM video_generation_submission_attempt WHERE video_generation_id=$1`, t.id, cfg.memberID).Scan(&count, &global, &snapshot); err != nil {
		return err
	}
	if snapshot != nil {
		retries = *snapshot
	}
	if count >= retries+1 {
		return errors.New("video submission retry budget exhausted")
	}
	var supplier string
	if err = tx.QueryRow(ctx, `SELECT LEFT(COALESCE(NULLIF(trim(name),''),'Video provider'),120) FROM image_backend_member WHERE id=$1`, cfg.memberID).Scan(&supplier); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO video_generation_submission_attempt(id,video_generation_id,backend_member_id,member_attempt_number,global_attempt_number,request_id,retry_count_snapshot,max_attempts_snapshot,supplier_name_snapshot,api_adapter_member_id,api_adapter_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$3,$10)`, newRequestID(), t.id, cfg.memberID, count+1, global+1, t.id, retries, retries+1, supplier, cfg.versionID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE video_generation SET stage='submitting',status='running',backend_member_id=$3,api_adapter_member_id=$3,api_adapter_version_id=$4,attempt_count=attempt_count+1,submit_started_at=now(),capacity_wait_deadline_at=NULL,next_poll_at=NULL,error=NULL,state_version=state_version+1,updated_at=now() WHERE id=$1 AND claim_token=$2`, t.id, t.token, cfg.memberID, cfg.versionID)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	t.stage, t.memberID, t.versionID = "submitting", cfg.memberID, cfg.versionID
	return nil
}

func (w *mediaWorker) retryVideoSubmission(ctx context.Context, t *videoWorkerTask, cfg providerConfig, cause error) error {
	if errors.Is(cause, errVideoClaimLost) {
		return cause
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var failure *videoProviderError
	if !errors.As(cause, &failure) {
		var busy *scriptRuntimeUnavailableError
		if errors.As(cause, &busy) {
			failure = &videoProviderError{code: "upstream_unavailable", transient: true, retryAfter: busy.retryAfterSeconds}
		} else {
			failure = &videoProviderError{code: "unknown_submission_failure", terminal: true}
		}
	}
	message := sanitizeWorkerError(failure)
	_, err := w.backend.db.Exec(ctx, `UPDATE video_generation_submission_attempt SET failure_code=$2,failure_reason=$3,operations_reason=$3,failed_at=now(),updated_at=now() WHERE id=(SELECT id FROM video_generation_submission_attempt WHERE video_generation_id=$1 ORDER BY global_attempt_number DESC LIMIT 1) AND failed_at IS NULL AND EXISTS(SELECT 1 FROM video_generation WHERE id=$1 AND claim_token=$4 AND claim_expires_at>now())`, t.id, failure.code, message, t.token)
	if err != nil {
		return err
	}
	if failure.terminal {
		return w.failClaimedVideo(ctx, t, failure)
	}
	var attempts int
	var maxAttempts *int
	if err = w.backend.db.QueryRow(ctx, `SELECT count(*),max(max_attempts_snapshot) FROM video_generation_submission_attempt WHERE video_generation_id=$1 AND backend_member_id=$2`, t.id, cfg.memberID).Scan(&attempts, &maxAttempts); err != nil {
		return err
	}
	// An old submitting row without an attempt ledger is not evidence that a
	// POST can be safely repeated. Refund it instead of inventing a new attempt.
	if maxAttempts == nil {
		return w.failClaimedVideo(ctx, t, errors.New("interrupted video submission has no attempt ledger"))
	}
	switchMember := failure.switchMember || attempts >= *maxAttempts
	delay := 5
	if failure.retryAfter > delay {
		delay = failure.retryAfter
	}
	set := `stage='retrying',status='running',next_poll_at=now()+$4::interval,submit_started_at=NULL,error=$5`
	if switchMember {
		set += `,backend_member_id=NULL,api_adapter_member_id=NULL,api_adapter_version_id=NULL,member_lease_id=NULL,member_lease_owner_token=NULL`
	}
	tx, err := w.backend.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err = videoCASTx(ctx, tx, t, set, (time.Duration(delay) * time.Second).String(), message); err != nil {
		return err
	}
	if switchMember {
		if err = mediaSchedulerResultTx(ctx, tx, "video", t.id, cfg.memberID, false, cause); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM image_backend_member_lease WHERE id=$1 AND owner_token=$2`, videoWorkerLeaseID(t.id), t.token); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	t.stage = "retrying"
	if switchMember {
		t.memberID, t.versionID = "", ""
	}
	return nil
}

func (w *mediaWorker) retryVideoQuery(ctx context.Context, t *videoWorkerTask, cause error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var failure *videoProviderError
	var busy *scriptRuntimeUnavailableError
	delay := 5
	failures := t.queryFailures
	if errors.As(cause, &failure) && failure.terminal {
		return w.failClaimedVideo(ctx, t, cause)
	}
	if errors.As(cause, &failure) && failure.transient {
		if failure.retryAfter > delay {
			delay = failure.retryAfter
		}
	} else if errors.As(cause, &busy) {
		if busy.retryAfterSeconds > delay {
			delay = busy.retryAfterSeconds
		}
	} else {
		failures++
	}
	if failures >= 3 {
		return w.failClaimedVideo(ctx, t, errors.New("video provider query failed three consecutive times"))
	}
	return w.videoCAS(ctx, t, `api_adapter_query_failure_count=$4,next_poll_at=now()+$5::interval,error=$6`, failures, (time.Duration(delay) * time.Second).String(), sanitizeWorkerError(cause))
}

func videoPollDelay(output map[string]any) time.Duration {
	seconds := int(goInt64(output["__fluxVideoPollAfterSeconds"]))
	if seconds < 1 || seconds > 300 {
		seconds = 5
	}
	return time.Duration(seconds) * time.Second
}
func (w *mediaWorker) videoWait(ctx context.Context, t *videoWorkerTask, seconds int, cause error) error {
	var msg any
	if cause != nil {
		msg = sanitizeWorkerError(cause)
	}
	return w.videoCAS(ctx, t, `next_poll_at=now()+$4::interval,error=$5`, (time.Duration(seconds) * time.Second).String(), msg)
}
func (w *mediaWorker) videoCapacityWait(ctx context.Context, t *videoWorkerTask) error {
	var deadline *time.Time
	if err := w.backend.db.QueryRow(ctx, `SELECT capacity_wait_deadline_at FROM video_generation WHERE id=$1`, t.id).Scan(&deadline); err != nil {
		return err
	}
	if deadline != nil && time.Now().After(*deadline) {
		return w.failClaimedVideo(ctx, t, &videoProviderError{code: "capacity_wait_timeout", terminal: true})
	}
	return w.videoCAS(ctx, t, `capacity_wait_deadline_at=COALESCE(capacity_wait_deadline_at,now()+interval '10 minutes'),next_poll_at=now()+interval '5 seconds'`)
}

func (w *mediaWorker) failClaimedVideo(ctx context.Context, t *videoWorkerTask, cause error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if t.stage == "refunding" || t.stage == "failed" {
		return w.refundVideoTask(ctx, t.id, sanitizeWorkerError(cause))
	}
	var code any
	var failure *videoProviderError
	if errors.As(cause, &failure) {
		code = failure.code
	}
	tx, err := w.backend.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err := videoCASTx(ctx, tx, t, `stage='refunding',status='failed',failure_code=$4,error=$5,next_poll_at=now()`, code, sanitizeWorkerError(cause)); err != nil {
		return err
	}
	if err = mediaSchedulerResultTx(ctx, tx, "video", t.id, t.memberID, false, cause, true); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM image_backend_member_lease WHERE id=$1 AND owner_token=$2`, videoWorkerLeaseID(t.id), t.token); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	t.stage = "refunding"
	return w.refundVideoTask(ctx, t.id, sanitizeWorkerError(cause))
}

func (w *mediaWorker) acceptVideoDownload(ctx context.Context, t *videoWorkerTask, videoURL string) error {
	if t.bucket == "" {
		_, bucket, err := w.backend.storageBuckets(ctx)
		if err != nil {
			return err
		}
		t.bucket = bucket
	}
	t.storageKey = fmt.Sprintf("%s/videos/%s.mp4", t.userID, t.id)
	if err := w.videoCAS(ctx, t, `stage='downloading',status='running',video_url=$4,storage_bucket=$5,storage_key=$6,next_poll_at=now(),upstream_accepted_at=COALESCE(upstream_accepted_at,now()),api_adapter_query_failure_count=0,error=NULL`, videoURL, t.bucket, t.storageKey); err != nil {
		return err
	}
	t.stage, t.videoURL = "downloading", videoURL
	return w.downloadClaimedVideo(ctx, t)
}

func (w *mediaWorker) downloadClaimedVideo(ctx context.Context, t *videoWorkerTask) error {
	if t.videoURL == "" || t.bucket == "" || t.storageKey == "" || !validStorageObjectPath(t.bucket, t.storageKey) || !strings.HasPrefix(t.storageKey, t.userID+"/") {
		return w.failClaimedVideo(ctx, t, errors.New("video download recovery information missing"))
	}
	data, mime, err := downloadVideoMedia(ctx, t.videoURL)
	if err != nil {
		var failure *videoProviderError
		if errors.As(err, &failure) && failure.transient {
			return w.videoWait(ctx, t, 10, err)
		}
		return w.failClaimedVideo(ctx, t, err)
	}
	// Recheck ownership after network I/O before writing the deterministic key.
	if err = w.videoCAS(ctx, t, `next_poll_at=now()`); err != nil {
		return err
	}
	if err = w.backend.putStorageObject(ctx, t.bucket, t.storageKey, data, mime); err != nil {
		return w.videoWait(ctx, t, 10, errors.New("video output storage temporarily unavailable"))
	}
	tx, err := w.backend.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	tag, err := tx.Exec(ctx, `UPDATE video_generation SET status='completed',stage='completed',video_url=$3,api_key_credits_reserved=0,claim_token=NULL,claim_expires_at=NULL,next_poll_at=NULL,error=NULL,completed_at=now(),state_version=state_version+1,updated_at=now() WHERE id=$1 AND claim_token=$2 AND claim_expires_at>now() AND stage='downloading'`, t.id, t.token, "/api/storage/"+urlPathEscape(t.bucket)+"/"+urlPathEscape(t.storageKey))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errVideoClaimLost
	}
	err = recordMediaOutputTx(ctx, tx, "video", t.id)
	if err != nil {
		return err
	}
	if err = mediaSchedulerResultTx(ctx, tx, "video", t.id, t.memberID, true, nil); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM image_backend_member_lease WHERE id=$1 AND owner_token=$2`, videoWorkerLeaseID(t.id), t.token); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type videoSnapshotContextKey struct{}
type videoBeforeSendContextKey struct{}

func base64DecodeForVideoSnapshot(value string) ([]byte, error) {
	return base64.StdEncoding.Strict().DecodeString(value)
}
func urlForVideoSnapshot(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil {
		return "", err
	}
	if (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", errors.New("not an HTTP URL")
	}
	u.User = nil
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

// Keep the adapter-visible shape, replacing media tokens and sensitive fields
// before writing the request history. Signed URLs and bytes never enter SQL.
func videoRequestSnapshot(payload any, media map[string]*videoProviderMedia) map[string]any {
	nodes, remaining := 0, 60000
	var visit func(any, string) any
	visit = func(value any, field string) any {
		nodes++
		if nodes > 2000 {
			return "[TRUNCATED]"
		}
		lower := strings.ToLower(field)
		for _, sensitive := range []string{"authorization", "api_key", "apikey", "token", "secret", "password", "signature", "cookie", "credential"} {
			if strings.Contains(lower, sensitive) {
				return "[REDACTED]"
			}
		}
		switch v := value.(type) {
		case string:
			if _, ok := media[v]; ok {
				return "[MEDIA]"
			}
			if strings.HasPrefix(strings.ToLower(v), "data:") {
				return "data:[REDACTED]"
			}
			if len(v) > 512 {
				if _, err := base64DecodeForVideoSnapshot(v); err == nil {
					return "[BASE64]"
				}
			}
			if u, err := urlForVideoSnapshot(v); err == nil {
				v = u
			}
			if len(v) > 12000 {
				v = v[:12000] + "[TRUNCATED]"
			}
			if len(v) > remaining {
				return "[TRUNCATED]"
			}
			remaining -= len(v)
			return v
		case map[string]any:
			out := map[string]any{}
			for key, item := range v {
				if len(out) >= 200 {
					break
				}
				out[key] = visit(item, key)
			}
			return out
		case []any:
			out := []any{}
			for i, item := range v {
				if i >= 100 {
					out = append(out, "[TRUNCATED]")
					break
				}
				out = append(out, visit(item, field))
			}
			return out
		default:
			return value
		}
	}
	return map[string]any{"operation": "videos.generate", "contentType": "application/json", "body": visit(payload, "")}
}
