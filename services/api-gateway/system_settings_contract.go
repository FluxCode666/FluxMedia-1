package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:generate node ../../apps/web/node_modules/tsx/dist/cli.mjs system_settings_generate.mts
//go:embed system_settings_definitions.json
var systemSettingDefinitionsJSON []byte

type settingDefinition struct {
	Key                         string          `json:"key"`
	Label                       string          `json:"label"`
	Description                 string          `json:"description"`
	Category                    string          `json:"category"`
	ValueType                   string          `json:"valueType"`
	Secret                      bool            `json:"secret,omitempty"`
	RequiresRestart             bool            `json:"requiresRestart,omitempty"`
	RequiresRebuild             bool            `json:"requiresRebuild,omitempty"`
	Options                     []settingOption `json:"options,omitempty"`
	Min                         *float64        `json:"min,omitempty"`
	Max                         *float64        `json:"max,omitempty"`
	Integer                     bool            `json:"integer,omitempty"`
	DefaultValue                any             `json:"defaultValue,omitempty"`
	ExampleValue                any             `json:"exampleValue,omitempty"`
	ManagedByDedicatedOperation bool            `json:"managedByDedicatedOperation,omitempty"`
}
type settingOption struct {
	Label string `json:"label"`
	Value string `json:"value"`
}
type storedSystemSetting struct {
	Value     any
	Secret    bool
	UpdatedAt *time.Time
}
type adminSettingSnapshot struct {
	settingDefinition
	Value      string     `json:"value"`
	Configured bool       `json:"configured"`
	Stored     bool       `json:"stored"`
	FromEnv    bool       `json:"fromEnv"`
	UpdatedAt  *time.Time `json:"updatedAt"`
}

var systemSettingDefinitions, systemSettingDefinitionByKey = loadSystemSettingDefinitions()

func loadSystemSettingDefinitions() ([]settingDefinition, map[string]settingDefinition) {
	var definitions []settingDefinition
	if err := json.Unmarshal(systemSettingDefinitionsJSON, &definitions); err != nil {
		panic(fmt.Errorf("decode embedded setting definitions: %w", err))
	}
	byKey := make(map[string]settingDefinition, len(definitions))
	for _, d := range definitions {
		if _, exists := byKey[d.Key]; exists {
			panic("duplicate embedded setting definition")
		}
		byKey[d.Key] = d
	}
	return definitions, byKey
}
func configuredSetting(value any) bool {
	if value == nil {
		return false
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text) != ""
	}
	return true
}
func systemSettingsSnapshot(stored map[string]storedSystemSetting, env func(string) (string, bool)) []adminSettingSnapshot {
	result := make([]adminSettingSnapshot, 0, len(systemSettingDefinitions))
	for _, d := range systemSettingDefinitions {
		row := stored[d.Key]
		envValue, _ := env(d.Key)
		envValue = strings.TrimSpace(envValue)
		if d.ManagedByDedicatedOperation {
			envValue = ""
		}
		hasStored := configuredSetting(row.Value)
		item := adminSettingSnapshot{settingDefinition: d, Stored: hasStored, Configured: hasStored || envValue != "", FromEnv: !hasStored && envValue != "", UpdatedAt: row.UpdatedAt}
		if !d.Secret && !row.Secret {
			if hasStored {
				if _, ok := row.Value.(string); ok {
					item.Value = row.Value.(string)
				} else {
					encoded, _ := json.MarshalIndent(row.Value, "", "  ")
					item.Value = string(encoded)
				}
			} else {
				item.Value = envValue
			}
		}
		// The definition is authoritative, but historical rows marked secret must
		// also stay hidden if metadata changes during a deployment.
		if row.Secret {
			item.Secret = true
		}
		result = append(result, item)
	}
	return result
}

type systemSettingsReader interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func readSystemSettings(ctx context.Context, db systemSettingsReader) (map[string]storedSystemSetting, error) {
	rows, err := db.Query(ctx, `SELECT key,value,is_secret,updated_at FROM system_setting ORDER BY key`)
	if err != nil {
		return nil, fmt.Errorf("read system settings: %w", err)
	}
	defer rows.Close()
	values := map[string]storedSystemSetting{}
	for rows.Next() {
		var key string
		var raw []byte
		var row storedSystemSetting
		if err := rows.Scan(&key, &raw, &row.Secret, &row.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan setting: %w", err)
		}
		if err := json.Unmarshal(raw, &row.Value); err != nil {
			return nil, fmt.Errorf("decode setting %s: %w", key, err)
		}
		values[key] = row
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read settings rows: %w", err)
	}
	return values, nil
}
func coerceSystemSetting(d settingDefinition, value any) (any, error) {
	bad := func(message string) (any, error) { return nil, invalid(d.Label + message) }
	switch d.ValueType {
	case "boolean":
		switch v := value.(type) {
		case bool:
			return v, nil
		case string:
			s := strings.ToLower(v)
			return s == "1" || s == "true" || s == "yes" || s == "on", nil
		case float64:
			return v != 0, nil
		default:
			return value != nil, nil
		}
	case "number":
		var n float64
		switch v := value.(type) {
		case float64:
			n = v
		case string:
			if strings.TrimSpace(v) == "" {
				return "", nil
			}
			var err error
			n, err = strconv.ParseFloat(strings.TrimSpace(v), 64)
			if err != nil {
				return bad("必须是有效数字")
			}
		case json.Number:
			var err error
			n, err = v.Float64()
			if err != nil {
				return bad("必须是有效数字")
			}
		default:
			return bad("必须是有效数字")
		}
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return bad("必须是有效数字")
		}
		if d.Integer && (math.Trunc(n) != n || math.Abs(n) > 9007199254740991) {
			return bad("必须是整数")
		}
		if d.Min != nil && n < *d.Min {
			return bad("不能小于 " + strconv.FormatFloat(*d.Min, 'f', -1, 64))
		}
		if d.Max != nil && n > *d.Max {
			return bad("不能大于 " + strconv.FormatFloat(*d.Max, 'f', -1, 64))
		}
		return n, nil
	case "json":
		if value == nil {
			return "", nil
		}
		if text, ok := value.(string); ok {
			if strings.TrimSpace(text) == "" {
				return "", nil
			}
			if err := json.Unmarshal([]byte(text), &value); err != nil {
				return bad("必须是有效 JSON")
			}
		}
		if d.Key == "REFERRAL_REWARD_CONFIG" && !validSettingsReferral(value) {
			return bad("必须包含 enabled、inviter 和 invitee 的有效奖励配置")
		}
		if d.Key == "DASHBOARD_SUPPORT_CONFIG" && !validSettingsDashboardSupport(value) {
			return bad("字段或链接格式无效")
		}
		if d.Key == "PAGINATION_PAGE_SIZE_OPTIONS" {
			items, ok := value.([]any)
			if !ok || len(items) == 0 || len(items) > 10 {
				return bad("必须是包含 20 的不重复整数数组")
			}
			seen := map[float64]bool{}
			for _, v := range items {
				n, ok := v.(float64)
				if !ok || n < 1 || n > 100 || math.Trunc(n) != n || seen[n] {
					return bad("必须是包含 20 的不重复整数数组")
				}
				seen[n] = true
			}
			if !seen[20] {
				return bad("必须包含 20")
			}
		}
		return value, nil
	default:
		text := ""
		if value != nil {
			text = strings.TrimSpace(toSettingText(value))
		}
		if d.ValueType == "select" && text != "" {
			for _, o := range d.Options {
				if o.Value == text {
					return text, nil
				}
			}
			return bad("取值无效")
		}
		if (d.Key == "SYSTEM_ASSETS_BUCKET_NAME" || d.Key == "GENERATIONS_BUCKET_NAME") && text == "_avatars" {
			return bad("不能使用系统保留名称")
		}
		return text, nil
	}
}
