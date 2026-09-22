package main

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type operationsExportClaim struct {
	ID, Owner, ExportType, TimeZone, EpochDate, Token string
	Query, HighWatermarks                             []byte
	SnapshotAt, EpochStart                            time.Time
	Attempt, SchemaVersion                            int
}
type operationsExportCSV struct {
	file        *os.File
	rows, bytes int64
	checksum    string
}

func (s *operationsExportCSV) close() {
	if s != nil && s.file != nil {
		_ = s.file.Close()
		_ = os.Remove(s.file.Name())
	}
}

func csvCell(v any) string {
	s := exportString(v)
	if len(s) > 0 && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}
func exportString(v any) string {
	if v == nil {
		return ""
	}
	if p, ok := v.(*string); ok {
		if p == nil {
			return ""
		}
		return *p
	}
	return fmt.Sprint(v)
}
func formatExportAmount(value any, currency string) string {
	var amount int64
	switch v := value.(type) {
	case int64:
		amount = v
	case int:
		amount = int64(v)
	case float64:
		amount = int64(v)
	case json.Number:
		amount, _ = v.Int64()
	default:
		return exportString(value)
	}
	exponent := 2
	switch strings.ToUpper(strings.TrimSpace(currency)) {
	case "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF":
		exponent = 0
	case "BHD", "KWD", "OMR":
		exponent = 3
	}
	if exponent == 0 {
		return strconv.FormatInt(amount, 10)
	}
	// Format the sign separately, including amounts between -1 and 0 major units.
	s := strconv.FormatInt(amount, 10)
	negative := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	for len(s) <= exponent {
		s = "0" + s
	}
	s = s[:len(s)-exponent] + "." + s[len(s)-exponent:]
	if negative {
		s = "-" + s
	}
	return s
}
func formatExportCredits(value any) string {
	v, e := strconv.ParseFloat(exportString(value), 64)
	if e != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return ""
	}
	return strconv.FormatFloat(v, 'f', 2, 64)
}
func formatOperationsExportDate(value any, zone *time.Location) (string, error) {
	if value == nil {
		return "", nil
	}
	var t time.Time
	switch v := value.(type) {
	case time.Time:
		t = v
	case string:
		var e error
		t, e = time.Parse(time.RFC3339Nano, v)
		if e != nil {
			return "", e
		}
	default:
		return "", errors.New("invalid export date")
	}
	return t.In(zone).Format("2006-01-02T15:04:05.000-07:00"), nil
}

func validateOperationsExportWatermarks(raw []byte) (map[string]any, error) {
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil || len(out) != 6 {
		return nil, errors.New("invalid export high watermarks")
	}
	fields := map[string][]string{"users": {"createdAt", "id"}, "webVisits": {"createdAt", "userId", "appDate"}, "outputs": {"createdAt", "outputKind", "sourceTaskId"}, "paymentOrders": {"createdAt", "id"}, "paymentLifecycle": {"recordedAt", "id"}, "creditContributions": {"projectedAt", "transactionId"}}
	for key, names := range fields {
		v, ok := out[key]
		if !ok {
			return nil, errors.New("missing export high watermark")
		}
		if v == nil {
			continue
		}
		entry, ok := v.(map[string]any)
		if !ok || len(entry) != len(names) {
			return nil, errors.New("invalid export high watermark")
		}
		for i, name := range names {
			s, ok := entry[name].(string)
			if !ok {
				return nil, errors.New("invalid export high watermark field")
			}
			if i == 0 {
				if _, e := time.Parse(time.RFC3339Nano, s); e != nil {
					return nil, e
				}
			}
		}
	}
	return out, nil
}

type operationsExportQuerySpec struct {
	kind, label, activity string
	retention             int
}

func operationsExportSpecs(kind string) []operationsExportQuerySpec {
	switch kind {
	case "commercialization":
		return []operationsExportQuerySpec{{kind: "orders", label: "orders"}, {kind: "fulfilled_orders", label: "fulfilled_orders"}, {kind: "payment_lifecycle", label: "payment_lifecycle"}}
	case "content_production":
		return []operationsExportQuerySpec{{kind: "content", label: "content"}}
	default:
		return []operationsExportQuerySpec{{kind: "cumulative_users", label: "cumulative_users"}, {kind: "users", label: "users"}, {kind: "activity", label: "login_activity", activity: "login"}, {kind: "activity", label: "creation_activity", activity: "creation"}, {kind: "activity", label: "payment_activity", activity: "payment"}, {kind: "cohort_export", label: "retention_d1", retention: 1}, {kind: "cohort_export", label: "retention_d7", retention: 7}, {kind: "cohort_export", label: "retention_d30", retention: 30}}
	}
}

// A repeatable-read view, append watermarks and the frozen business clock keep
// all sections on the same source membership. Each keyset page is bounded;
// CSV bytes are spooled to disk and hashed while writing, never held in RAM.
func (b *backend) buildOperationsExportCSV(ctx context.Context, task operationsExportClaim) (result *operationsExportCSV, resultErr error) {
	if task.SchemaVersion != 1 || !operationsExportTypeValid(task.ExportType) {
		return nil, errors.New("unsupported export schema")
	}
	var query map[string]any
	if json.Unmarshal(task.Query, &query) != nil {
		return nil, errors.New("invalid export query")
	}
	query, err := validateOperationsQuery(query)
	if err != nil {
		return nil, err
	}
	rangeInput := query["range"].(map[string]any)
	if rangeInput["kind"] != "custom" {
		return nil, errors.New("export range is not frozen")
	}
	zone, err := time.LoadLocation(task.TimeZone)
	if err != nil {
		return nil, err
	}
	start := operationsDateStart(rangeInput["from"].(string), zone)
	end := operationsDateStart(operationsAddDate(rangeInput["to"].(string), 1), zone)
	if end.After(task.SnapshotAt) {
		end = task.SnapshotAt
	}
	watermarks, err := validateOperationsExportWatermarks(task.HighWatermarks)
	if err != nil {
		return nil, err
	}
	headers := []string{}
	switch task.ExportType {
	case "user_growth":
		headers = []string{"记录类型", "用户 ID", "名称", "邮箱", "业务时间", "角色", "封禁", "留存"}
	case "commercialization":
		headers = []string{"记录类型", "平台订单 ID", "支付渠道交易号", "用户 ID", "币种", "金额", "订单状态", "创建时间", "履约时间", "生命周期事件"}
	case "content_production":
		headers = []string{"任务 ID", "用户 ID", "模型", "媒体类型", "业务时间", "状态", "数量", "视频秒数", "积分净用量"}
	}
	file, err := os.CreateTemp("", "fluxmedia-operations-*.csv")
	if err != nil {
		return nil, err
	}
	result = &operationsExportCSV{file: file}
	defer func() {
		if resultErr != nil {
			result.close()
		}
	}()
	hash := sha256.New()
	dest := io.MultiWriter(file, hash)
	if _, err = dest.Write([]byte{0xef, 0xbb, 0xbf}); err != nil {
		return result, err
	}
	writer := csv.NewWriter(dest)
	writer.UseCRLF = true
	if err = writer.Write(headers); err != nil {
		return result, err
	}
	tx, err := b.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, err
	}
	defer rollback(tx)
	dataStart := start
	if dataStart.Before(task.EpochStart) {
		dataStart = task.EpochStart
	}
	for _, spec := range operationsExportSpecs(task.ExportType) {
		if !dataStart.Before(end) && spec.kind != "cumulative_users" {
			continue
		}
		q := operationsDetailReadQuery{Kind: spec.kind, Start: dataStart, End: end, EpochStart: task.EpochStart, AsOf: task.SnapshotAt, Limit: 1001, HighWatermarks: watermarks, TimeZone: task.TimeZone, ActivityKind: spec.activity, RetentionDay: spec.retention, Detail: "credit_usage"}
		if spec.kind == "cumulative_users" {
			q.Start = start
		}
		for {
			if err = ctx.Err(); err != nil {
				return result, err
			}
			rows, e := readOperationsDetailRows(ctx, tx, q)
			if e != nil {
				return result, e
			}
			count := len(rows)
			if count > 1000 {
				count = 1000
			}
			for _, row := range rows[:count] {
				m := row.Public
				var cells []any
				if task.ExportType == "commercialization" {
					created, e := formatOperationsExportDate(m["createdAt"], zone)
					if e != nil {
						return result, e
					}
					fulfilled, e := formatOperationsExportDate(m["fulfilledAt"], zone)
					if e != nil {
						return result, e
					}
					cells = []any{spec.label, m["paymentOrderId"], m["providerTradeNo"], m["userId"], m["currency"], formatExportAmount(m["amountMinor"], exportString(m["currency"])), m["orderStatus"], created, fulfilled, m["eventType"]}
				} else {
					business, e := formatOperationsExportDate(m["businessTime"], zone)
					if e != nil {
						return result, e
					}
					if task.ExportType == "user_growth" {
						cells = []any{spec.label, m["userId"], m["name"], m["email"], business, m["role"], m["banned"], m["retained"]}
					} else {
						cells = []any{m["taskId"], m["userId"], m["model"], m["mediaType"], business, m["status"], m["quantity"], m["videoSeconds"], formatExportCredits(m["netCredits"])}
					}
				}
				values := make([]string, len(cells))
				for i, v := range cells {
					values[i] = csvCell(v)
				}
				if err = writer.Write(values); err != nil {
					return result, err
				}
				result.rows++
			}
			if len(rows) <= 1000 {
				break
			}
			position := rows[count-1].Position
			q.Cursor = &position
		}
	}
	writer.Flush()
	if err = writer.Error(); err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	info, err := file.Stat()
	if err != nil {
		return result, err
	}
	result.bytes = info.Size()
	result.checksum = hex.EncodeToString(hash.Sum(nil))
	return result, nil
}
