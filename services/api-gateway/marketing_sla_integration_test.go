//go:build integration

package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func isolatedMarketingSLABackend(t *testing.T) *backend {
	t.Helper()
	original := integrationBackend(t)
	schema := "sla_" + newRequestID()
	ctx := context.Background()
	if _, err := original.db.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := original.db.Exec(context.Background(), `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Error(err)
		}
	})
	if _, err := original.db.Exec(ctx, `CREATE TABLE `+schema+`.generation (LIKE public.generation INCLUDING ALL)`); err != nil {
		t.Fatal(err)
	}
	cfg := original.db.Config()
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &backend{config: original.config, db: pool, redis: original.redis, logger: original.logger}
}

func TestHomepageSLAUsesRecentTerminalTasksAndActualFailureCategories(t *testing.T) {
	b := isolatedMarketingSLABackend(t)
	ctx := context.Background()
	read := func() map[string]any {
		t.Helper()
		w := authRequest(t, b, http.MethodGet, "/api/marketing/sla-stats", "")
		if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
			t.Fatal("SLA response was cacheable")
		}
		return requireCreditResponse(t, w, http.StatusOK)
	}
	assert := func(want map[string]any) {
		t.Helper()
		got := read()
		for key, value := range want {
			if got[key] != value {
				t.Fatalf("%s=%v, want %v: %+v", key, got[key], value, got)
			}
		}
	}
	assert(map[string]any{"sampleSize": float64(0), "successRate": float64(1)})
	old := time.Now().UTC().Add(-48 * time.Hour)
	for i, row := range []struct{ status, message string }{
		{"completed", ""}, {"completed", ""},
		{"failed", "no available image quota | insufficient_quota"},
		{"failed", "抱歉，我不能帮助生成此内容"},
		{"failed", "unsupported image mode"},
		{"pending", ""},
	} {
		if _, err := b.db.Exec(ctx, `INSERT INTO generation(id,user_id,prompt,model,size,status,error,created_at) VALUES($1,'sla-user','sla prompt','gpt-image-1','1024x1024',$2,NULLIF($3,''),$4)`, fmt.Sprintf("sample-%d", i), row.status, row.message, old.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	assert(map[string]any{"sampleSize": float64(5), "completed": float64(2), "failed": float64(3), "platformErrors": float64(1), "moderationErrors": float64(1), "userRequestErrors": float64(1), "successRate": float64(2) / 3})
	if _, err := b.db.Exec(ctx, `DELETE FROM generation WHERE status<>'failed' OR error NOT LIKE '%insufficient_quota%'`); err != nil {
		t.Fatal(err)
	}
	assert(map[string]any{"sampleSize": float64(1), "platformErrors": float64(1), "successRate": float64(0)})
	if _, err := b.db.Exec(ctx, `UPDATE generation SET error='invalid image data'`); err != nil {
		t.Fatal(err)
	}
	assert(map[string]any{"sampleSize": float64(1), "platformErrors": float64(0), "userRequestErrors": float64(1), "successRate": float64(1)})
	if _, err := b.db.Exec(ctx, `DELETE FROM generation`); err != nil {
		t.Fatal(err)
	}
	// Older terminal history still supplies the sample. The oldest failed row
	// lies outside the 1000-task cap, while newer pending tasks consume no slots.
	if _, err := b.db.Exec(ctx, `INSERT INTO generation(id,user_id,prompt,model,size,status,error,created_at) SELECT 'terminal-'||n,'sla-user','sla prompt','gpt-image-1','1024x1024',CASE WHEN n=0 THEN 'failed'::generation_status ELSE 'completed'::generation_status END,CASE WHEN n=0 THEN 'upstream failure' ELSE NULL END,$1::timestamp+n*interval '1 second' FROM generate_series(0,1000) n`, old); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO generation(id,user_id,prompt,model,size,status,created_at) SELECT 'pending-'||n,'sla-user','sla prompt','gpt-image-1','1024x1024','pending',now() FROM generate_series(1,1200) n`); err != nil {
		t.Fatal(err)
	}
	assert(map[string]any{"sampleSize": float64(1000), "completed": float64(1000), "failed": float64(0), "successRate": float64(1)})
}
