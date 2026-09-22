package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const globalModerationPolicyAction = "moderation.setGlobalRiskLevel"
const globalModerationPolicySetting = "CONTENT_MODERATION_BLOCK_RISK_LEVEL"

func (b *backend) handleSystemModerationPolicyGet(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, true); err != nil {
		return err
	}
	tx, err := b.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer rollback(tx)
	var raw []byte
	err = tx.QueryRow(r.Context(), `SELECT value FROM system_setting WHERE key=$1`, globalModerationPolicySetting).Scan(&raw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var value any
	if len(raw) > 0 {
		if err = json.Unmarshal(raw, &value); err != nil {
			return err
		}
	}
	level, _ := value.(string)
	source := "global"
	if level != "low" && level != "medium" && level != "high" {
		level, source = "high", "fallback_high"
	}
	rows, err := tx.Query(r.Context(), `SELECT id,admin_user_id,reason,before,after,metadata,created_at FROM admin_audit_log WHERE action=$1 AND target_user_id IS NULL ORDER BY created_at DESC,id DESC LIMIT 10`, globalModerationPolicyAction)
	if err != nil {
		return err
	}
	audits := []map[string]any{}
	for rows.Next() {
		var id string
		var actor, reason *string
		var before, after, metadata json.RawMessage
		var at time.Time
		if err = rows.Scan(&id, &actor, &reason, &before, &after, &metadata, &at); err != nil {
			rows.Close()
			return err
		}
		audits = append(audits, map[string]any{"id": id, "adminUserId": actor, "reason": reason, "before": before, "after": after, "metadata": metadata, "createdAt": at.UTC()})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 200, map[string]any{"policy": map[string]any{"globalDefault": level, "userOverride": nil, "effectiveLevel": level, "source": source}, "recentAudits": audits})
	return nil
}

func (b *backend) handleSystemModerationPolicyPut(w http.ResponseWriter, r *http.Request) error {
	actor, err := b.requireAdmin(r, true)
	if err != nil {
		return err
	}
	var input struct{ Level, Reason string }
	if err = decodeBody(r, &input); err != nil {
		return err
	}
	if input.Level != "low" && input.Level != "medium" && input.Level != "high" {
		return invalid("审核级别不合法")
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if input.Reason == "" || len([]rune(input.Reason)) > 300 {
		return invalid("变更原因不合法")
	}
	requestRef := strings.TrimSpace(requestID(r))
	if requestRef == "" {
		requestRef = newRequestID()
	}
	if len(requestRef) > 200 {
		return invalid("请求标识不合法")
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	var raw []byte
	var updated time.Time
	err = tx.QueryRow(r.Context(), `SELECT value,updated_at FROM system_setting WHERE key=$1 FOR UPDATE`, globalModerationPolicySetting).Scan(&raw, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{409, "INVARIANT_ERROR", "全站审核策略尚未初始化"}
	}
	if err != nil {
		return err
	}
	var before any
	if err = json.Unmarshal(raw, &before); err != nil {
		return err
	}
	previousLevel, validLevel := before.(string)
	changed := !validLevel || previousLevel != input.Level
	var auditID *string
	if changed {
		updated = time.Now().UTC().Truncate(time.Microsecond)
		if _, err = tx.Exec(r.Context(), `UPDATE system_setting SET value=$2,is_secret=false,updated_by=$3,updated_at=$4 WHERE key=$1`, globalModerationPolicySetting, mustJSON(input.Level), actor.User.ID, updated); err != nil {
			return err
		}
		id := newRequestID()
		auditID = &id
		metadata := map[string]any{"requestId": requestRef, "operation": globalModerationPolicyAction, "actorUserId": actor.User.ID, "actorRole": actor.User.Role, "targetUserId": nil, "targetRole": nil}
		if _, err = tx.Exec(r.Context(), `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after,metadata,created_at) VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8)`, id, actor.User.ID, globalModerationPolicyAction, input.Reason, mustJSON(map[string]any{"level": before}), mustJSON(map[string]any{"level": input.Level}), mustJSON(metadata), updated); err != nil {
			return err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 200, map[string]any{"success": true, "changed": changed, "previousLevel": before, "level": input.Level, "before": before, "after": input.Level, "auditLogId": auditID, "updatedAt": updated.UTC(), "message": map[bool]string{true: "全站审核级别已更新", false: "全站审核级别未发生变化"}[changed]})
	return nil
}
