package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const userModerationPolicyAction = "moderation.setUserRiskLevelOverride"

func resolveUserModerationPolicy(raw []byte, override *string) map[string]any {
	var global string
	_ = json.Unmarshal(raw, &global)
	source := "global"
	if global != "low" && global != "medium" && global != "high" {
		global, source = "high", "fallback_high"
	}
	effective := global
	if override != nil && (*override == "low" || *override == "medium" || *override == "high") {
		effective, source = *override, "user_override"
	} else {
		override = nil
	}
	return map[string]any{"globalDefault": global, "userOverride": override, "effectiveLevel": effective, "source": source}
}

func (b *backend) handleAdminUserModerationGet(w http.ResponseWriter, r *http.Request) error {
	id := strings.TrimSpace(r.PathValue("id"))
	if !b.cronAuthorized(r) {
		if _, err := b.requireAdminViewer(r); err != nil {
			return err
		}
	}
	if id == "" {
		return invalid("userId is required")
	}
	var override *string
	var global []byte
	err := b.db.QueryRow(r.Context(), `SELECT u.moderation_block_risk_level_override,s.value FROM "user" u LEFT JOIN system_setting s ON s.key=$2 WHERE u.id=$1`, id, globalModerationPolicySetting).Scan(&override, &global)
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{404, "NOT_FOUND", "用户不存在"}
	}
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, resolveUserModerationPolicy(global, override))
	return nil
}

func (b *backend) handleAdminUserModeration(w http.ResponseWriter, r *http.Request) error {
	actor, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	id := strings.TrimSpace(r.PathValue("id"))
	var input struct {
		UserID string          `json:"userId"`
		Level  json.RawMessage `json:"level"`
		Reason string          `json:"reason"`
	}
	if err = decodeBody(r, &input); err != nil {
		return err
	}
	if id == "" || (input.UserID != "" && input.UserID != id) {
		return invalid("用户标识不匹配")
	}
	var level *string
	if len(input.Level) == 0 || json.Unmarshal(input.Level, &level) != nil || (level != nil && *level != "low" && *level != "medium" && *level != "high") {
		return invalid("审核级别不合法")
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if input.Reason == "" || len([]rune(input.Reason)) > 300 {
		return invalid("操作原因不合法")
	}
	requestRef := strings.TrimSpace(requestID(r))
	if requestRef == "" {
		requestRef = newRequestID()
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	var before *string
	var role string
	var updated time.Time
	err = tx.QueryRow(r.Context(), `SELECT moderation_block_risk_level_override,role,updated_at FROM "user" WHERE id=$1 FOR UPDATE`, id).Scan(&before, &role, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{404, "NOT_FOUND", "用户不存在"}
	}
	if err != nil {
		return err
	}
	if actor.User.Role != "super_admin" && (actor.User.ID == id || (role != "user" && role != "observer_admin")) {
		return forbidden()
	}
	var global []byte
	err = tx.QueryRow(r.Context(), `SELECT value FROM system_setting WHERE key=$1`, globalModerationPolicySetting).Scan(&global)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	policy := resolveUserModerationPolicy(global, level)
	changed := (before == nil) != (level == nil) || (before != nil && level != nil && *before != *level)
	var auditID *string
	if changed {
		updated = time.Now().UTC().Truncate(time.Microsecond)
		if _, err = tx.Exec(r.Context(), `UPDATE "user" SET moderation_block_risk_level_override=$2,updated_at=$3 WHERE id=$1`, id, level, updated); err != nil {
			return err
		}
		value := newRequestID()
		auditID = &value
		metadata := map[string]any{"requestId": requestRef, "operation": userModerationPolicyAction, "actorUserId": actor.User.ID, "actorRole": actor.User.Role, "targetUserId": id, "targetRole": role}
		if _, err = tx.Exec(r.Context(), `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, value, actor.User.ID, id, userModerationPolicyAction, input.Reason, mustJSON(map[string]any{"level": before}), mustJSON(map[string]any{"level": level}), mustJSON(metadata), updated); err != nil {
			return err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"changed": changed, "before": before, "after": level, "effectiveLevel": policy["effectiveLevel"], "source": policy["source"], "auditLogId": auditID, "updatedAt": updated.UTC()})
	return nil
}
