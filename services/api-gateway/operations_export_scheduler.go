package main

import (
	"context"
	"strconv"
	"time"
)

// Poll only configuration every five seconds. Work uses the independently
// configured process (default one minute) and retention (default one hour)
// intervals, batch sizes and enable switches inherited from the Next service.
func (s *maintenanceScheduler) loopOperationsExports(ctx context.Context, retention bool) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	var last time.Time
	for {
		if err := s.tickOperationsExports(ctx, retention, &last); err != nil && ctx.Err() == nil {
			phase := "process"
			if retention {
				phase = "expire"
			}
			s.backend.logger.ErrorContext(ctx, "operations export maintenance failed", "phase", phase, "error_code", "operations_export_maintenance_failed")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *maintenanceScheduler) tickOperationsExports(ctx context.Context, retention bool, last *time.Time) error {
	phase := "PROCESS"
	defaultInterval, defaultBatch, maxInterval := 1, 10, 1440
	if retention {
		phase = "EXPIRE"
		defaultInterval, defaultBatch, maxInterval = 60, 100, 10080
	}
	base := "INTERNAL_JOB_OPERATIONS_EXPORT_" + phase
	enabled, err := s.backend.settingBool(ctx, base+"_ENABLED", false)
	if err != nil {
		return err
	}
	if !enabled {
		*last = time.Time{}
		return nil
	}
	readInt := func(key string, fallback, max int) (int, error) {
		raw, e := s.backend.settingString(ctx, key, strconv.Itoa(fallback))
		if e != nil {
			return 0, e
		}
		n, e := strconv.Atoi(raw)
		if e != nil || n < 1 || n > max {
			return 0, invalid("运营导出调度设置无效")
		}
		return n, nil
	}
	interval, err := readInt(base+"_INTERVAL_MINUTES", defaultInterval, maxInterval)
	if err != nil {
		return err
	}
	if !last.IsZero() && time.Since(*last) < time.Duration(interval)*time.Minute {
		return nil
	}
	batch, err := readInt(base+"_BATCH_SIZE", defaultBatch, 100)
	if err != nil {
		return err
	}
	started := time.Now()
	var processed int
	if retention {
		processed, err = s.backend.expireOperationsExports(ctx, batch)
	} else {
		processed, err = s.backend.processOperationsExports(ctx, batch)
	}
	*last = time.Now()
	if err == nil && processed > 0 {
		s.backend.logger.InfoContext(ctx, "operations export maintenance completed", "phase", phase, "processed", processed, "duration_ms", time.Since(started).Milliseconds())
	}
	return err
}
