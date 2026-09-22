package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// Queued and polling images retain user admission until their generation is
// settled. The lock serializes admissions across all Go replicas.
func (b *backend) admitImageTask(ctx context.Context, tx pgx.Tx, userID string) (int, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "image-admission:"+userID); err != nil {
		return 0, err
	}
	var override *int
	if err := tx.QueryRow(ctx, `SELECT image_generation_concurrency_override FROM "user" WHERE id=$1`, userID).Scan(&override); err != nil {
		return 0, err
	}
	limit, err := b.settingInt((&http.Request{}).WithContext(ctx), "IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY", 20, 1, 10000)
	if err != nil {
		return 0, err
	}
	if override != nil {
		limit = *override
	}
	var active int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM image_async_task t JOIN generation g ON g.id=t.generation_id WHERE t.user_id=$1 AND t.status IN ('queued','running') AND g.status='pending'`, userID).Scan(&active); err != nil {
		return 0, err
	}
	if active >= limit {
		return 0, &apiError{429, "CONCURRENCY_LIMIT_EXCEEDED", fmt.Sprintf("已达到当前用户生图并发上限（%d），请等待现有任务完成", limit)}
	}
	return limit, nil
}

// A short transaction reserves a global execution slot and the task claim
// together. Poll waits release execution capacity but retain user admission.
func (w *mediaWorker) claimImageTask(ctx context.Context, requestedID string) (string, error) {
	b := w.backend
	limit, err := b.settingInt((&http.Request{}).WithContext(ctx), "IMAGE_GENERATION_GLOBAL_CONCURRENCY", 500, 1, 10000)
	if err != nil {
		return "", err
	}
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('image-global-execution',0))`); err != nil {
		return "", err
	}
	var active int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM image_async_task WHERE status='running' AND claim_token IS NOT NULL AND claim_expires_at>now()`).Scan(&active); err != nil {
		return "", err
	}
	if active >= limit {
		return "", nil
	}
	var id string
	err = tx.QueryRow(ctx, `WITH candidate AS (
	 SELECT id FROM image_async_task WHERE ($3='' OR id=$3)
	 AND (status='queued' OR status='running' AND (claim_expires_at IS NULL OR claim_expires_at<=now()))
	 AND (mq_delivery_due_at IS NULL OR mq_delivery_due_at<=now())
	 ORDER BY COALESCE(group_priority_snapshot,2147483647),created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
	) UPDATE image_async_task task SET status='running',claim_token=$1,claim_expires_at=now()+$2::interval,
	 attempt_count=task.attempt_count+1,started_at=COALESCE(task.started_at,now()),mq_delivery_due_at=NULL,updated_at=now()
	 FROM candidate WHERE task.id=candidate.id RETURNING task.id`, newWorkerToken(), mediaWorkerClaimTTL.String(), requestedID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

func (w *mediaWorker) processClaimedImage(ctx context.Context, id string) error {
	return w.processImage(ctx, id)
}
