package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type operationsDetailInput struct {
	Query, Selection map[string]any
	Limit            int
	Cursor           string
}

func includes(values []string, value string) bool { return slices.Contains(values, value) }
func readOperationsDetailHighWatermarks(ctx context.Context, db operationsDB, asOf time.Time) (map[string]any, error) {
	var raw []byte
	if e := db.QueryRow(ctx, operationsExportWatermarkSQL).Scan(&raw); e != nil {
		return nil, e
	}
	var out map[string]any
	e := json.Unmarshal(raw, &out)
	return out, e
}
func opsOnlyKeys(input map[string]any, keys ...string) bool {
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	for key := range input {
		if !allowed[key] {
			return false
		}
	}
	return true
}
func validateOperationsDetailInput(raw map[string]any) (operationsDetailInput, error) {
	var in operationsDetailInput
	if raw == nil || !opsOnlyKeys(raw, "granularity", "range", "selection", "limit", "cursor") {
		return in, invalid("运营明细查询包含未知字段")
	}
	base := map[string]any{}
	for _, key := range []string{"granularity", "range"} {
		if v, ok := raw[key]; ok {
			base[key] = v
		}
	}
	var e error
	in.Query, e = validateOperationsQuery(base)
	if e != nil {
		return in, e
	}
	in.Limit = 100
	if v, ok := raw["limit"]; ok {
		n, ok := v.(float64)
		if !ok || n < 1 || n > 500 || float64(int(n)) != n {
			return in, invalid("运营明细页大小无效")
		}
		in.Limit = int(n)
	}
	if v, ok := raw["cursor"]; ok {
		var valid bool
		in.Cursor, valid = v.(string)
		in.Cursor = strings.TrimSpace(in.Cursor)
		if !valid || len(in.Cursor) < 1 || len(in.Cursor) > 4096 {
			return in, invalid("运营明细游标无效")
		}
	}
	selection, ok := raw["selection"].(map[string]any)
	if !ok {
		return in, invalid("运营明细选择无效")
	}
	module, detail := stringValue(selection["module"]), stringValue(selection["detail"])
	keys := []string{"module", "detail"}
	valid := true
	switch module {
	case "growth":
		switch detail {
		case "users", "login_activity", "creation_activity", "payment_activity":
		case "cumulative_users":
			keys = append(keys, "cutoffDate")
			_, e = operationsDate(stringValue(selection["cutoffDate"]))
		case "activity_bucket":
			keys = append(keys, "activityKind", "bucket")
			valid = includes([]string{"new_users", "login", "creation", "payment"}, stringValue(selection["activityKind"]))
		case "retention_cohorts":
			keys = append(keys, "cohortDate", "retentionDay")
			_, e = operationsDate(stringValue(selection["cohortDate"]))
			v, ok := selection["retentionDay"].(float64)
			valid = ok && (v == 1 || v == 7 || v == 30)
		default:
			valid = false
		}
	case "commercialization":
		switch detail {
		case "orders", "payment_lifecycle":
		case "fulfilled_orders":
			keys = append(keys, "currency")
		case "payment_stage":
			keys = append(keys, "stage", "currency")
			valid = includes([]string{"created_orders", "pending_orders", "payment_confirmed_orders", "paid_not_fulfilled_orders", "fulfilled_orders", "failed_orders"}, stringValue(selection["stage"]))
		default:
			valid = false
		}
	case "content":
		switch detail {
		case "image_outputs", "video_outputs", "credit_usage":
		case "content_bucket":
			keys = append(keys, "contentKind", "bucket")
			valid = includes([]string{"image", "video", "credits"}, stringValue(selection["contentKind"]))
		default:
			valid = false
		}
	default:
		valid = false
	}
	if e != nil || !valid || !opsOnlyKeys(selection, keys...) {
		return in, invalid("运营明细选择无效")
	}
	if v, ok := selection["currency"]; ok {
		if !regexp.MustCompile(`^[A-Z]{3}$`).MatchString(stringValue(v)) {
			return in, invalid("运营明细币种无效")
		}
	}
	if detail == "activity_bucket" || detail == "content_bucket" {
		bucket, ok := selection["bucket"].(map[string]any)
		if !ok || len(bucket) != 2 || !opsOnlyKeys(bucket, "from", "to") {
			return in, invalid("运营明细桶无效")
		}
		from, to := stringValue(bucket["from"]), stringValue(bucket["to"])
		if _, e = operationsDate(from); e != nil {
			return in, e
		}
		if _, e = operationsDate(to); e != nil {
			return in, e
		}
		if from > to {
			return in, invalid("运营明细桶无效")
		}
	}
	in.Selection = selection
	return in, nil
}

func buildOperationsDetailReadQuery(in operationsDetailInput, rng map[string]any, epoch time.Time) (operationsDetailReadQuery, error) {
	start, end := operationsDataBounds(rng)
	q := operationsDetailReadQuery{Start: start, End: end, EpochStart: epoch, AsOf: operationsTime(rng["asOf"]), Limit: in.Limit + 1, TimeZone: stringValue(rng["timeZone"])}
	loc, _ := time.LoadLocation(q.TimeZone)
	detail, module := stringValue(in.Selection["detail"]), stringValue(in.Selection["module"])
	bucket := func() error {
		b := in.Selection["bucket"].(map[string]any)
		from, to := stringValue(b["from"]), stringValue(b["to"])
		if from < stringValue(rng["from"]) || to > stringValue(rng["to"]) {
			return invalid("运营明细桶不属于当前筛选范围")
		}
		bs, be := operationsDateStart(from, loc), operationsDateStart(operationsAddDate(to, 1), loc)
		if be.After(end) && to == stringValue(rng["to"]) {
			be = end
		}
		if bs.Before(operationsTime(rng["start"])) || be.After(end) || !bs.Before(be) {
			return invalid("运营明细桶不属于当前筛选范围")
		}
		if bs.Before(epoch) {
			bs = epoch
		}
		if !bs.Before(be) {
			return invalid("上线前运营明细不可下钻")
		}
		q.Start, q.End = bs, be
		return nil
	}
	switch module {
	case "growth":
		switch detail {
		case "cumulative_users":
			if in.Selection["cutoffDate"] != rng["to"] {
				return q, invalid("累计用户截止日必须等于当前筛选范围结束日")
			}
			q.Kind = "cumulative_users"
			q.Start = operationsTime(rng["start"])
		case "users":
			q.Kind = "users"
		case "login_activity", "creation_activity", "payment_activity":
			q.Kind = "activity"
			q.ActivityKind = strings.TrimSuffix(detail, "_activity")
		case "activity_bucket":
			if e := bucket(); e != nil {
				return q, e
			}
			q.ActivityKind = stringValue(in.Selection["activityKind"])
			q.Kind = "activity"
			if q.ActivityKind == "new_users" {
				q.Kind = "users"
			}
		case "retention_cohorts":
			q.Kind = "cohort"
			date := stringValue(in.Selection["cohortDate"])
			day := int(in.Selection["retentionDay"].(float64))
			cs := operationsDateStart(date, loc)
			ts := operationsDateStart(operationsAddDate(date, day), loc)
			if cs.Before(start) || !cs.Before(end) || cs.Before(epoch) || ts.After(q.AsOf) {
				return q, invalid("Cohort 明细不属于当前范围或尚未成熟")
			}
			q.Start, q.End = cs, operationsDateStart(operationsAddDate(date, 1), loc)
			q.TargetStart, q.TargetEnd = ts, operationsDateStart(operationsAddDate(date, day+1), loc)
			if q.TargetEnd.After(q.AsOf) {
				q.TargetEnd = q.AsOf
			}
		}
	case "commercialization":
		q.Kind = detail
		q.Stage = stringValue(in.Selection["stage"])
		q.Currency = stringValue(in.Selection["currency"])
	case "content":
		q.Kind = "content"
		q.Detail = detail
		if detail == "content_bucket" {
			if e := bucket(); e != nil {
				return q, e
			}
			q.Detail = map[string]string{"image": "image_outputs", "video": "video_outputs", "credits": "credit_usage"}[stringValue(in.Selection["contentKind"])]
		}
	}
	return q, nil
}

type operationsDetailCursor struct {
	Version                            int `json:"v"`
	Actor, Filter, TimeZone, EpochDate string
	AsOf                               time.Time
	Position                           operationsDetailPosition
	HighWatermarks                     map[string]any
}

func opsDetailFilter(in operationsDetailInput, zone, epoch, secret string) string {
	raw, _ := json.Marshal(map[string]any{"query": in.Query, "selection": in.Selection, "limit": in.Limit, "zone": zone, "epoch": epoch})
	return base64.RawURLEncoding.EncodeToString(historyMAC(secret, "fluxmedia:operations-detail:filters:go-v1", string(raw)))
}
func encodeOpsDetailCursor(c operationsDetailCursor, secret string) string {
	raw, _ := json.Marshal(c)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return payload + "." + base64.RawURLEncoding.EncodeToString(historyMAC(secret, "fluxmedia:operations-detail:cursor:go-v1", payload))
}
func decodeOpsDetailCursor(token, actor, filter, zone, epoch, secret string, now time.Time) (operationsDetailCursor, error) {
	var c operationsDetailCursor
	fail := invalid("运营明细游标无效")
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return c, fail
	}
	raw, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil || base64.RawURLEncoding.EncodeToString(raw) != parts[0] {
		return c, fail
	}
	sig, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil || base64.RawURLEncoding.EncodeToString(sig) != parts[1] || !hmac.Equal(sig, historyMAC(secret, "fluxmedia:operations-detail:cursor:go-v1", parts[0])) {
		return c, fail
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil || c.Version != 1 || c.Actor != actor || c.Filter != filter || c.TimeZone != zone || c.EpochDate != epoch || c.AsOf.IsZero() || c.AsOf.After(now) || c.Position.BusinessTime.IsZero() || c.Position.BusinessTime.After(c.AsOf) || c.Position.StableID == "" || len(c.Position.StableID) > 512 || c.HighWatermarks == nil {
		return c, fail
	}
	return c, nil
}

func (b *backend) handleOperationsDetailMigrated(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	session, e := b.requireAdmin(r, false)
	if e != nil {
		return e
	}
	var raw map[string]any
	if e = decodeBody(r, &raw); e != nil {
		return e
	}
	in, e := validateOperationsDetailInput(raw)
	if e != nil {
		return e
	}
	secret := b.config.authSecret
	if strings.TrimSpace(secret) == "" {
		return &apiError{503, "NOT_READY", "运营明细游标密钥尚未配置"}
	}
	ctx := r.Context()
	tx, e := b.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return e
	}
	defer rollback(tx)
	now, date, epoch, zone, e := operationsSnapshotHeader(ctx, tx)
	if e != nil {
		return e
	}
	filter := opsDetailFilter(in, zone, date, secret)
	c := operationsDetailCursor{Version: 1, Actor: session.User.ID, Filter: filter, TimeZone: zone, EpochDate: date, AsOf: now}
	if in.Cursor != "" {
		c, e = decodeOpsDetailCursor(in.Cursor, session.User.ID, filter, zone, date, secret, now)
		if e != nil {
			return e
		}
	} else {
		c.HighWatermarks, e = readOperationsDetailHighWatermarks(ctx, tx, now)
		if e != nil {
			return e
		}
	}
	rng, e := resolveOperationsRange(c.AsOf, zone, date, in.Query)
	if e != nil {
		return e
	}
	out := []any{}
	var next any
	if rng["dataStart"] != nil || in.Selection["detail"] == "cumulative_users" {
		q, e := buildOperationsDetailReadQuery(in, rng, epoch)
		if e != nil {
			return e
		}
		q.HighWatermarks = c.HighWatermarks
		q.LiveValues = true
		if in.Cursor != "" {
			q.Cursor = &c.Position
		}
		rows, e := readOperationsDetailRows(ctx, tx, q)
		if e != nil {
			return e
		}
		if len(rows) > in.Limit {
			rows = rows[:in.Limit]
			c.Position = rows[len(rows)-1].Position
			next = encodeOpsDetailCursor(c, secret)
		}
		for _, row := range rows {
			out = append(out, row.Public)
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"selection": in.Selection, "range": rng, "rows": out, "nextCursor": next})
	return nil
}
