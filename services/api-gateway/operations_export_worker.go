package main

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *backend) claimOperationsExport(ctx context.Context) (operationsExportClaim, error) {
	task := operationsExportClaim{Token: newRequestID()}
	err := b.db.QueryRow(ctx, `WITH candidate AS(SELECT id FROM operations_export_task WHERE status='queued' OR(status='running' AND lease_expires_at<=clock_timestamp()) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE operations_export_task t SET status='running',attempt_count=t.attempt_count+1,lease_owner='go-operations-export',lease_token=$1,lease_expires_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp() FROM candidate WHERE t.id=candidate.id RETURNING t.id,t.created_by,t.export_type,t.query,t.time_zone,t.epoch_app_date,t.epoch_starts_at,t.snapshot_at,t.high_watermarks,t.attempt_count,t.schema_version`, task.Token).Scan(&task.ID, &task.Owner, &task.ExportType, &task.Query, &task.TimeZone, &task.EpochDate, &task.EpochStart, &task.SnapshotAt, &task.HighWatermarks, &task.Attempt, &task.SchemaVersion)
	return task, err
}
func (b *backend) renewOperationsExport(ctx context.Context, task operationsExportClaim) error {
	tag, err := b.db.Exec(ctx, `UPDATE operations_export_task SET lease_expires_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp() WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_expires_at>clock_timestamp()`, task.ID, task.Token)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("operations export lease lost")
	}
	return nil
}
func (b *backend) guardOperationsExport(ctx context.Context, task operationsExportClaim) (context.Context, func() error) {
	work, cancel := context.WithCancelCause(ctx)
	stop := make(chan struct{})
	done := make(chan struct{})
	var once sync.Once
	go func() {
		defer close(done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-work.Done():
				return
			case <-stop:
				return
			case <-ticker.C:
				c, finish := context.WithTimeout(work, 15*time.Second)
				err := b.renewOperationsExport(c, task)
				finish()
				if err != nil {
					cancel(err)
					return
				}
			}
		}
	}()
	return work, func() error {
		once.Do(func() { close(stop) })
		<-done
		err := context.Cause(work)
		cancel(context.Canceled)
		return err
	}
}

func (b *backend) failOperationsExport(ctx context.Context, task operationsExportClaim, code string) error {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	tag, err := tx.Exec(ctx, `UPDATE operations_export_task SET status='failed',error_code=$3,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_expires_at>clock_timestamp()`, task.ID, task.Token, code)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	if err = operationsExportAudit(ctx, tx, task.Owner, "operations.failExport", task.ID, map[string]any{"errorCode": code, "attemptCount": task.Attempt}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (b *backend) completeOperationsExport(ctx context.Context, task operationsExportClaim, bucket, key string, data *operationsExportCSV) (bool, error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer rollback(tx)
	tag, err := tx.Exec(ctx, `UPDATE operations_export_task SET status='completed',object_bucket=$3,object_key=$4,checksum_sha256=$5,row_count=$6,byte_count=$7,completed_at=clock_timestamp(),expires_at=clock_timestamp()+interval '7 days',error_code=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_expires_at>clock_timestamp()`, task.ID, task.Token, bucket, key, data.checksum, data.rows, data.bytes)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if err = operationsExportAudit(ctx, tx, task.Owner, "operations.completeExport", task.ID, map[string]any{"rowCount": data.rows, "byteCount": data.bytes, "checksumSha256": data.checksum}); err != nil {
		return false, err
	}
	err = tx.Commit(ctx)
	return err == nil, err
}
func (b *backend) recordOperationsExportOrphan(ctx context.Context, task operationsExportClaim, bucket, key, code string) error {
	return operationsExportAudit(ctx, b.db, "", "operations.exportOrphan", task.ID, map[string]any{"leaseToken": task.Token, "objectBucket": bucket, "objectKey": key, "errorCode": code})
}

func (b *backend) processOperationsExports(ctx context.Context, limit int) (int, error) {
	processed := 0
	for processed < limit {
		task, err := b.claimOperationsExport(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return processed, nil
		}
		if err != nil {
			return processed, err
		}
		processed++
		if task.Attempt > 8 {
			if err = b.failOperationsExport(ctx, task, "max_attempts_exceeded"); err != nil {
				return processed, err
			}
			continue
		}
		if err = b.runOperationsExport(ctx, task); err != nil {
			return processed, err
		}
	}
	return processed, nil
}
func (b *backend) runOperationsExport(ctx context.Context, task operationsExportClaim) error {
	work, stop := b.guardOperationsExport(ctx, task)
	defer stop()
	data, err := b.buildOperationsExportCSV(work, task)
	if err != nil {
		if context.Cause(work) != nil {
			return nil
		}
		return b.failOperationsExport(ctx, task, "export_failed")
	}
	defer data.close()
	storage, err := b.operationsExportStorage(work)
	if err != nil {
		return b.failOperationsExport(ctx, task, "storage_failed")
	}
	key := "operations-exports/" + task.ID + "/" + task.Token + ".csv"
	if err = storage.put(work, key, data.file, data.bytes); err != nil {
		c, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		if e := b.recordOperationsExportOrphan(c, task, storage.bucket, key, "upload_failed"); e != nil {
			return e
		}
		if context.Cause(work) != nil {
			return nil
		}
		return b.failOperationsExport(c, task, "storage_failed")
	}
	// Keep an uploaded candidate until its final DB outcome is known. Cleanup
	// always rechecks live references and leases; an ambiguous COMMIT must never
	// cause us to delete the object of a successfully completed task.
	if err = stop(); err != nil {
		c, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		return b.recordOperationsExportOrphan(c, task, storage.bucket, key, "lease_lost")
	}
	completed, err := b.completeOperationsExport(ctx, task, storage.bucket, key, data)
	if completed {
		return nil
	}
	c, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	code := "completion_rejected"
	if err != nil {
		code = "completion_unknown"
	}
	return b.recordOperationsExportOrphan(c, task, storage.bucket, key, code)
}

func (b *backend) handleOperationsExpireExportsJob(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return unauthorized()
	}
	var input struct {
		Limit int `json:"limit"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if input.Limit < 1 || input.Limit > 100 {
		input.Limit = 100
	}
	processed, err := b.expireOperationsExports(r.Context(), input.Limit)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"processed": processed})
	return nil
}

func (b *backend) expireOperationsExports(ctx context.Context, limit int) (int, error) {
	storage, err := b.operationsExportStorage(ctx)
	if err != nil {
		return 0, err
	}
	// Change visibility before touching storage. Failed physical deletion leaves
	// an expired row with durable coordinates and retry metadata.
	_, err = b.db.Exec(ctx, `WITH candidate AS(SELECT id FROM operations_export_task WHERE status='completed' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE operations_export_task t SET status='expired',updated_at=clock_timestamp() FROM candidate WHERE t.id=candidate.id`, limit)
	if err != nil {
		return 0, err
	}
	rows, err := b.db.Query(ctx, `SELECT id,object_bucket,object_key FROM operations_export_task WHERE status='expired' AND object_deleted_at IS NULL ORDER BY updated_at,id LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	type expired struct{ id, bucket, key string }
	objects := []expired{}
	for rows.Next() {
		var o expired
		if err = rows.Scan(&o.id, &o.bucket, &o.key); err != nil {
			rows.Close()
			return 0, err
		}
		objects = append(objects, o)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	processed := 0
	for _, o := range objects {
		if err = storage.delete(ctx, o.bucket, o.key); err != nil {
			if _, e := b.db.Exec(ctx, `UPDATE operations_export_task SET cleanup_error_code='storage_delete_failed',updated_at=clock_timestamp() WHERE id=$1 AND status='expired' AND object_deleted_at IS NULL`, o.id); e != nil {
				return processed, e
			}
			continue
		}
		tag, e := b.db.Exec(ctx, `UPDATE operations_export_task SET object_deleted_at=clock_timestamp(),cleanup_error_code=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='expired' AND object_deleted_at IS NULL AND object_bucket=$2 AND object_key=$3`, o.id, o.bucket, o.key)
		if e != nil {
			return processed, e
		}
		processed += int(tag.RowsAffected())
	}
	if err = b.cleanOperationsExportOrphans(ctx, storage, limit); err != nil {
		return processed, err
	}
	if err = b.discoverOperationsExportOrphans(ctx, storage, limit); err != nil {
		return processed, err
	}
	return processed, nil
}

func (b *backend) operationsExportObjectProtected(ctx context.Context, task, token, bucket, key string) (bool, error) {
	var protected bool
	err := b.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_export_task WHERE object_bucket=$1 AND object_key=$2 AND object_deleted_at IS NULL) OR EXISTS(SELECT 1 FROM operations_export_task WHERE id=$3 AND status='running' AND lease_token=$4 AND lease_expires_at>clock_timestamp())`, bucket, key, task, token).Scan(&protected)
	return protected, err
}
func (b *backend) cleanOperationsExportOrphans(ctx context.Context, storage operationsExportStorage, limit int) error {
	rows, err := b.db.Query(ctx, `SELECT o.id,o.after->>'taskId',o.metadata->>'leaseToken',o.metadata->>'objectBucket',o.metadata->>'objectKey' FROM admin_audit_log o WHERE o.action='operations.exportOrphan' AND NOT EXISTS(SELECT 1 FROM admin_audit_log c WHERE c.action='operations.exportOrphanDeleted' AND c.metadata->>'orphanAuditId'=o.id) AND NOT EXISTS(SELECT 1 FROM operations_export_task t WHERE (t.object_bucket=o.metadata->>'objectBucket' AND t.object_key=o.metadata->>'objectKey' AND t.object_deleted_at IS NULL) OR (t.id=o.after->>'taskId' AND t.status='running' AND t.lease_token=o.metadata->>'leaseToken' AND t.lease_expires_at>clock_timestamp())) ORDER BY (SELECT max(f.created_at) FROM admin_audit_log f WHERE f.action='operations.exportOrphanCleanupFailed' AND f.metadata->>'orphanAuditId'=o.id) NULLS FIRST,o.created_at,o.id LIMIT $1`, limit)
	if err != nil {
		return err
	}
	type orphan struct{ id, task, token, bucket, key string }
	objects := []orphan{}
	for rows.Next() {
		var o orphan
		if err = rows.Scan(&o.id, &o.task, &o.token, &o.bucket, &o.key); err != nil {
			rows.Close()
			return err
		}
		objects = append(objects, o)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, o := range objects {
		protected, e := b.operationsExportObjectProtected(ctx, o.task, o.token, o.bucket, o.key)
		if e != nil {
			return e
		}
		if protected {
			continue
		}
		action := "operations.exportOrphanDeleted"
		metadata := map[string]any{"orphanAuditId": o.id, "objectKey": o.key}
		if e = storage.delete(ctx, o.bucket, o.key); e != nil {
			action = "operations.exportOrphanCleanupFailed"
			metadata["errorCode"] = "storage_delete_failed"
		}
		if e = operationsExportAudit(ctx, b.db, "", action, o.task, metadata); e != nil {
			return e
		}
	}
	return nil
}
