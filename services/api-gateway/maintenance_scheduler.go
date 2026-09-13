package main

// Go-native maintenance scheduler.  The scheduler drives the database-backed
// recovery handlers directly so a running Go backend no longer depends on the
// Next.js process for routine payment, image, or credit maintenance.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	maintenanceImageInterval   = 5 * time.Minute
	maintenanceCreditInterval  = 24 * time.Hour
	maintenancePaymentInterval = time.Minute
)

type maintenanceScheduler struct {
	backend *backend
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// startMaintenanceScheduler starts the Go-owned maintenance loop.  Set
// GO_BACKEND_SCHEDULER_ENABLED=false during rollout or tests to leave the
// existing external cron owner in control.
func (b *backend) startMaintenanceScheduler(parent context.Context) *maintenanceScheduler {
	if strings.EqualFold(strings.TrimSpace(osGetenv("GO_BACKEND_SCHEDULER_ENABLED")), "false") {
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	s := &maintenanceScheduler{backend: b, cancel: cancel}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.loop(ctx)
	}()
	return s
}

func (s *maintenanceScheduler) close() {
	if s == nil {
		return
	}
	s.cancel()
	s.wg.Wait()
}

func (s *maintenanceScheduler) loop(ctx context.Context) {
	imageTicker := time.NewTicker(maintenanceImageInterval)
	creditTicker := time.NewTicker(maintenanceCreditInterval)
	paymentTicker := time.NewTicker(maintenancePaymentInterval)
	defer imageTicker.Stop()
	defer creditTicker.Stop()
	defer paymentTicker.Stop()

	// Run payment recovery once at startup; image/credit jobs wait for their
	// configured cadence to avoid a burst immediately after deployment.
	s.runPayment(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-paymentTicker.C:
			s.runPayment(ctx)
		case <-imageTicker.C:
			s.runImages(ctx)
		case <-creditTicker.C:
			s.runCredits(ctx)
		}
	}
}

func (s *maintenanceScheduler) runPayment(ctx context.Context) {
	// recoverPaymentFulfillments uses SKIP LOCKED leases, so multiple backend
	// instances can safely execute this scan concurrently.
	if _, err := s.backend.recoverPaymentFulfillments(ctx, paymentFulfillmentBatch); err != nil {
		return
	}
}

func (s *maintenanceScheduler) runImages(ctx context.Context) {
	if _, err := s.backend.expireStaleImages(ctx); err != nil {
		return
	}
}

func (s *maintenanceScheduler) runCredits(ctx context.Context) {
	if err := s.backend.expireAllCredits(ctx); err != nil {
		return
	}
}

func (b *backend) expireStaleImages(ctx context.Context) (int64, error) {
	rows, err := b.db.Query(ctx, `SELECT id,user_id,COALESCE(credits_consumed,0),created_at,COALESCE(metadata,'{}'::json) FROM generation WHERE status='pending' AND created_at < now()-interval '20 minutes' ORDER BY created_at LIMIT 100`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var expired int64
	for rows.Next() {
		var id, userID string
		var amount float64
		var createdAt time.Time
		var metadataRaw []byte
		if err = rows.Scan(&id, &userID, &amount, &createdAt, &metadataRaw); err != nil {
			return expired, err
		}
		tx, txErr := b.db.Begin(ctx)
		if txErr != nil {
			return expired, txErr
		}
		var changed int64
		err = tx.QueryRow(ctx, `UPDATE generation SET status='failed',error='Generation timed out',completed_at=now(),credits_consumed=0,metadata=COALESCE(metadata,'{}'::jsonb)||$2::jsonb WHERE id=$1 AND status='pending' RETURNING 1`, id, mustJSON(map[string]any{"timeout": map[string]any{"reason": "pending_timeout", "timeoutMs": 20 * 60 * 1000, "refundSourceRef": id + ":timeout-refund"}})).Scan(&changed)
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			continue
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return expired, err
		}
		if amount > 0 {
			if err = b.insertGenerationRefund(ctx, tx, id, userID, amount, createdAt, metadataRaw, id+":timeout-refund", "Refund timed out image generation charge"); err != nil {
				_ = tx.Rollback(ctx)
				return expired, err
			}
		}
		if err = tx.Commit(ctx); err != nil {
			return expired, err
		}
		expired += changed
	}
	return expired, rows.Err()
}

// insertGenerationRefund writes the same idempotent ledger and usage projection
// used by the media worker. It runs inside the generation CAS transaction so a
// crash cannot leave a timed-out image marked failed without its refund.
func (b *backend) insertGenerationRefund(ctx context.Context, tx pgx.Tx, id, userID string, amount float64, createdAt time.Time, metadataRaw []byte, sourceRef, description string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO credits_batch(id,user_id,amount,remaining,source_type,source_ref,updated_at) VALUES($1,$2,$3,$3,'refund',$4,now()) ON CONFLICT(source_type,source_ref) DO NOTHING`, newRequestID(), userID, amount, sourceRef); err != nil {
		return err
	}
	txID := newRequestID()
	if tag, err := tx.Exec(ctx, `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,source_ref,operation_type,operation_id,operation_created_at,metadata,created_at) VALUES($1,$2,'refund',$3,'SYSTEM:generation_refund',$4,$5,$6,'image_generation',$7,$8,$9,now()) ON CONFLICT(user_id,type,source_ref) DO NOTHING`, txID, userID, amount, "WALLET:"+userID, description, sourceRef, id, createdAt, mustJSON(map[string]any{"generationId": id, "sourceRef": sourceRef, "worker": "go-maintenance"})); err != nil {
		return err
	} else if tag.RowsAffected() == 0 {
		return nil
	}
	var gross, refunded float64
	var operationCreatedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT gross_consumed,refunded,operation_created_at FROM credit_usage_operation WHERE user_id=$1 AND operation_type='image_generation' AND operation_id=$2 FOR UPDATE`, userID, id).Scan(&gross, &refunded, &operationCreatedAt); err == nil {
		if !operationCreatedAt.Equal(createdAt) || refunded+amount > gross {
			return fmt.Errorf("image timeout refund operation conflict for %s", id)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO credit_usage_projection_entry(transaction_id,user_id,contribution_kind,amount,operation_type,operation_id,operation_created_at,transaction_created_at) VALUES($1,$2,'refund',$3,'image_generation',$4,$5,now()) ON CONFLICT(transaction_id) DO NOTHING`, txID, userID, amount, id, createdAt); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE credit_usage_operation SET refunded=refunded+$3,net_consumed=net_consumed-$3,updated_at=now() WHERE user_id=$1 AND operation_type='image_generation' AND operation_id=$2`, userID, id, amount); err != nil {
			return err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE credits_balance SET balance=balance+$2,total_earned=total_earned+$2,total_refunded=total_refunded+$2,updated_at=now() WHERE user_id=$1`, userID, amount); err != nil {
		return err
	}
	var meta map[string]any
	_ = json.Unmarshal(metadataRaw, &meta)
	if key, _ := meta["externalApiKeyId"].(string); key != "" {
		if _, err := tx.Exec(ctx, `UPDATE external_api_key SET credits_used=GREATEST(0,credits_used-$3),updated_at=now() WHERE id=$1 AND user_id=$2`, key, userID, amount); err != nil {
			return err
		}
	}
	return nil
}

func (b *backend) expireAllCredits(ctx context.Context) error {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, `WITH expired AS (
		UPDATE credits_batch SET status='expired',updated_at=now()
		WHERE status='active' AND expires_at<now() AND remaining>0
		RETURNING id,user_id,remaining
	), ledger AS (
		INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,metadata)
		SELECT $1||id,user_id,'expiration',remaining,'WALLET:'||user_id,'SYSTEM:expired',
			'credit batch expired',json_build_object('batchId',id,'expiredAmount',remaining)
		FROM expired RETURNING user_id,amount
	)
	UPDATE credits_balance b SET balance=GREATEST(0,b.balance-COALESCE(
		(SELECT sum(amount) FROM ledger l WHERE l.user_id=b.user_id),0)),updated_at=now()
	WHERE EXISTS (SELECT 1 FROM ledger l WHERE l.user_id=b.user_id)`, newRequestID()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
