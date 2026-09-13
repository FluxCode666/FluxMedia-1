package main

// Go-native maintenance scheduler.  The scheduler drives the database-backed
// recovery handlers directly so a running Go backend no longer depends on the
// Next.js process for routine payment, image, or credit maintenance.

import (
	"context"
	"strings"
	"sync"
	"time"
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
	result, err := b.db.Exec(ctx, `UPDATE generation
		SET status='failed', error='Generation timed out', completed_at=now()
		WHERE status='pending' AND created_at < now()-interval '30 minutes'`)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
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
