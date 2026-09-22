package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type operationsDB interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func operationsDate(value string) (time.Time, error) {
	d, e := time.Parse("2006-01-02", value)
	if e != nil || d.Year() < 100 || d.Format("2006-01-02") != value {
		return time.Time{}, invalid("运营日期无效")
	}
	return d, nil
}
func operationsAddDate(value string, days int) string {
	d, _ := time.Parse("2006-01-02", value)
	return d.AddDate(0, 0, days).Format("2006-01-02")
}
func operationsDateStart(value string, loc *time.Location) time.Time {
	d, _ := time.ParseInLocation("2006-01-02", value, loc)
	return d.UTC()
}
func operationsTime(value any) time.Time {
	d, _ := time.Parse(time.RFC3339Nano, stringValue(value))
	return d
}
func operationsISO(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

// Normalize the exact public query, rejecting caller-selected clocks/epochs and
// invalid dates instead of silently exchanging/truncating them.
func validateOperationsQuery(input map[string]any) (map[string]any, error) {
	if input == nil {
		return nil, invalid("运营查询必须是对象")
	}
	for k := range input {
		if k != "range" && k != "granularity" {
			return nil, invalid("运营查询包含未知字段")
		}
	}
	granularity := "day"
	if v, ok := input["granularity"]; ok {
		granularity = stringValue(v)
	}
	if granularity != "day" && granularity != "week" && granularity != "month" {
		return nil, invalid("运营粒度无效")
	}
	rangeInput := map[string]any{"kind": "default"}
	if v, ok := input["range"]; ok {
		var valid bool
		rangeInput, valid = v.(map[string]any)
		if !valid {
			return nil, invalid("运营日期范围无效")
		}
	}
	kind := stringValue(rangeInput["kind"])
	switch kind {
	case "default", "this_week", "this_month", "this_year":
		if len(rangeInput) != 1 {
			return nil, invalid("运营日期范围包含未知字段")
		}
	case "custom":
		if len(rangeInput) != 3 {
			return nil, invalid("自定义日期范围无效")
		}
		from, to := stringValue(rangeInput["from"]), stringValue(rangeInput["to"])
		if _, e := operationsDate(from); e != nil {
			return nil, e
		}
		if _, e := operationsDate(to); e != nil {
			return nil, e
		}
		if from > to {
			return nil, invalid("结束日期不能早于开始日期")
		}
	default:
		return nil, invalid("运营日期范围无效")
	}
	return map[string]any{"range": rangeInput, "granularity": granularity}, nil
}

func resolveOperationsRange(now time.Time, tz, epochDate string, input map[string]any) (map[string]any, error) {
	query, e := validateOperationsQuery(input)
	if e != nil {
		return nil, e
	}
	loc, e := time.LoadLocation(strings.TrimSpace(tz))
	if e != nil {
		return nil, invalid("应用时区无效")
	}
	if _, e = operationsDate(epochDate); e != nil {
		return nil, e
	}
	today := now.In(loc).Format("2006-01-02")
	if epochDate > today {
		return nil, invalid("运营统计起点不能处于未来")
	}
	from, to := operationsAddDate(today, -29), today
	rangeInput := query["range"].(map[string]any)
	monday := func(value string) string {
		d, _ := operationsDate(value)
		day := (int(d.Weekday()) + 6) % 7
		return operationsAddDate(value, -day)
	}
	switch rangeInput["kind"] {
	case "custom":
		from, to = rangeInput["from"].(string), rangeInput["to"].(string)
	case "this_week":
		from = monday(today)
	case "this_month":
		from = today[:7] + "-01"
	case "this_year":
		from = today[:4] + "-01-01"
	}
	if to > today {
		return nil, invalid("结束日期不能处于未来")
	}
	fd, _ := operationsDate(from)
	td, _ := operationsDate(to)
	days := int(td.Sub(fd)/(24*time.Hour)) + 1
	availability := func(a, z string) (string, any) {
		if z < epochDate {
			return "pre_epoch", nil
		}
		if a < epochDate {
			return "partial_epoch", operationsISO(operationsDateStart(epochDate, loc))
		}
		return "available", operationsISO(operationsDateStart(a, loc))
	}
	start := operationsDateStart(from, loc)
	end := operationsDateStart(operationsAddDate(to, 1), loc)
	if to == today {
		end = now
	}
	prevFrom, prevTo := operationsAddDate(from, -days), operationsAddDate(from, -1)
	av, data := availability(from, to)
	pav, pdata := availability(prevFrom, prevTo)
	previous := map[string]any{"from": prevFrom, "to": prevTo, "start": operationsISO(operationsDateStart(prevFrom, loc)), "end": operationsISO(start), "dayCount": days, "availability": pav, "dataStart": pdata}
	granularity := query["granularity"].(string)
	logical := from
	if granularity == "week" {
		logical = monday(from)
	} else if granularity == "month" {
		logical = from[:7] + "-01"
	}
	buckets := []any{}
	for logical <= to {
		next := operationsAddDate(logical, 1)
		if granularity == "week" {
			next = operationsAddDate(logical, 7)
		} else if granularity == "month" {
			d, _ := operationsDate(logical)
			next = d.AddDate(0, 1, 0).Format("2006-01-02")
		}
		bf, bt := logical, operationsAddDate(next, -1)
		if bf < from {
			bf = from
		}
		if bt > to {
			bt = to
		}
		bav, bdata := availability(bf, bt)
		be := operationsDateStart(operationsAddDate(bt, 1), loc)
		if bt == today {
			be = now
		}
		buckets = append(buckets, map[string]any{"key": granularity + ":" + logical, "granularity": granularity, "from": bf, "to": bt, "start": operationsISO(operationsDateStart(bf, loc)), "end": operationsISO(be), "availability": bav, "dataFrom": bdata})
		logical = next
	}
	return map[string]any{"timeZone": strings.TrimSpace(tz), "asOf": operationsISO(now), "today": today, "epochDate": epochDate, "granularity": granularity, "from": from, "to": to, "start": operationsISO(start), "end": operationsISO(end), "dayCount": days, "availability": av, "dataStart": data, "previous": previous, "buckets": buckets}, nil
}

func operationsSnapshotHeader(ctx context.Context, db operationsDB) (asOf time.Time, epochDate string, epochStart time.Time, zone string, err error) {
	var date *string
	var start *time.Time
	var raw []byte
	err = db.QueryRow(ctx, `SELECT transaction_timestamp(),(SELECT app_date FROM operations_analytics_epoch WHERE id=1),(SELECT starts_at FROM operations_analytics_epoch WHERE id=1),(SELECT value FROM system_setting WHERE key='APP_TIME_ZONE')`).Scan(&asOf, &date, &start, &raw)
	if err != nil {
		return
	}
	// The transaction clock is timestamptz; persisted business columns are UTC
	// timestamp without time zone. pgx otherwise binds the local wall clock.
	asOf = asOf.UTC()
	if date == nil || start == nil {
		err = &apiError{503, "NOT_READY", "运营统计起点尚未初始化"}
		return
	}
	epochDate, epochStart = *date, *start
	epochStart = epochStart.UTC()
	zone = "UTC"
	if fallback := strings.TrimSpace(os.Getenv("APP_TIME_ZONE")); fallback != "" {
		zone = fallback
	}
	if len(raw) > 0 {
		if json.Unmarshal(raw, &zone) != nil {
			err = errors.New("invalid operations application timezone")
			return
		}
	}
	zone = strings.TrimSpace(zone)
	if _, e := time.LoadLocation(zone); e != nil {
		err = errors.New("invalid operations application timezone")
	}
	return
}

func operationsDataBounds(rng map[string]any) (time.Time, time.Time) {
	end := operationsTime(rng["end"])
	if rng["dataStart"] == nil {
		return end, end
	}
	return operationsTime(rng["dataStart"]), end
}
