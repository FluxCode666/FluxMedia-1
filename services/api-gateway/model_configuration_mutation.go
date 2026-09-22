package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
)

type modelConfigurationCommand struct {
	ClientRequestID  string  `json:"clientRequestId"`
	Category         string  `json:"category"`
	Key              string  `json:"configKey"`
	ExpectedRevision *int64  `json:"expectedRevision"`
	IsCustom         bool    `json:"isCustom,omitempty"`
	Enabled          *bool   `json:"enabled,omitempty"`
	Visible          *bool   `json:"visible,omitempty"`
	HomepageVisible  *bool   `json:"homepageVisible,omitempty"`
	HomepagePriority *int    `json:"homepagePriority,omitempty"`
	Description      *string `json:"description,omitempty"`
	IconKey          string  `json:"iconKey,omitempty"`
	CoverChange      *struct {
		Action string `json:"action"`
		Bytes  []byte `json:"bytes,omitempty"`
	} `json:"coverChange,omitempty"`
	Pricing              map[string]float64 `json:"pricing,omitempty"`
	BillingMode          string             `json:"billingMode,omitempty"`
	CreditsPerSecond     map[string]float64 `json:"creditsPerSecondByResolution,omitempty"`
	CreditsPerItem       map[string]float64 `json:"creditsPerItemByResolution,omitempty"`
	SupportedResolutions []string           `json:"supportedResolutions,omitempty"`
	OutputSizes          map[string]map[string]struct {
		Width  int64 `json:"width"`
		Height int64 `json:"height"`
	} `json:"outputSizesByResolution,omitempty"`
	SupportsQuality    *bool  `json:"supportsQuality,omitempty"`
	MaxReferenceImages *int64 `json:"maxReferenceImages,omitempty"`
}

func (b *backend) handleModelConfiguration(w http.ResponseWriter, r *http.Request) error {
	if r.Method == http.MethodGet {
		return b.handleModelConfigurationRead(w, r, nil)
	}
	var raw map[string]json.RawMessage
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		body, err := decodeObject(r)
		if err != nil {
			return err
		}
		raw = body
		if r.Method == http.MethodPost && rawString(body, "configKey") == "" {
			return b.handleModelConfigurationRead(w, r, body)
		}
	}
	s, err := b.requireAdmin(r, true)
	if err != nil {
		return err
	}
	if s.User.Role != "super_admin" {
		return forbidden()
	}
	if raw == nil {
		r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
		if err = r.ParseMultipartForm(1 << 20); err != nil {
			return invalid("模型配置表单无效或超过100MB")
		}
		defer r.MultipartForm.RemoveAll()
		raw = map[string]json.RawMessage{}
		for name, values := range r.MultipartForm.Value {
			if len(values) != 1 {
				return invalid("模型配置字段不能重复")
			}
			value := values[0]
			switch name {
			case "enabled", "visible", "homepageVisible", "homepagePriority", "expectedRevision", "isCustom", "supportedResolutions", "supportsQuality", "maxReferenceImages", "pricing", "creditsPerSecondByResolution", "creditsPerItemByResolution", "outputSizesByResolution":
				if !json.Valid([]byte(value)) {
					return invalid("模型配置字段格式无效: " + name)
				}
				raw[name] = json.RawMessage(value)
			case "coverChange":
				raw[name] = json.RawMessage(mustJSON(map[string]any{"action": value}))
			default:
				raw[name] = json.RawMessage(mustJSON(value))
			}
		}
		for name, files := range r.MultipartForm.File {
			if name != "cover" || len(files) != 1 {
				return invalid("封面文件字段无效")
			}
			var change map[string]any
			if json.Unmarshal(raw["coverChange"], &change) != nil || change["action"] != "replace" {
				return invalid("封面文件需要replace动作")
			}
			file, err := files[0].Open()
			if err != nil {
				return err
			}
			data, err := io.ReadAll(io.LimitReader(file, 100<<20+1))
			_ = file.Close()
			if err != nil {
				return err
			}
			if len(data) > 100<<20 {
				return &apiError{413, "REQUEST_BODY_TOO_LARGE", "封面请求过大"}
			}
			change["bytes"] = data
			raw["coverChange"] = json.RawMessage(mustJSON(change))
		}
	}
	var command modelConfigurationCommand
	decoder := json.NewDecoder(bytes.NewBufferString(mustJSON(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command); err != nil {
		return invalid("模型配置参数无效")
	}
	remove := r.Method == http.MethodDelete
	if remove && len(raw) != 4 {
		return invalid("删除模型只接受category、configKey、expectedRevision和clientRequestId")
	}
	result, err := b.applyModelConfiguration(r.Context(), s.User.ID, command, remove)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, result)
	return nil
}

func validateModelConfigurationCommand(command *modelConfigurationCommand, remove bool) error {
	command.Key = strings.TrimSpace(command.Key)
	if command.IsCustom {
		command.Key = strings.ToLower(command.Key)
	}
	if command.Category != "image" && command.Category != "video" {
		return invalid("模型类别无效")
	}
	if !uuidPattern.MatchString(command.ClientRequestID) || command.ExpectedRevision == nil || *command.ExpectedRevision < 0 || *command.ExpectedRevision > 9007199254740990 {
		return invalid("请求标识或配置版本无效")
	}
	if command.Key == "" || len(utf16.Encode([]rune(command.Key))) > 120 || strings.EqualFold(command.Key, "default") || isLegacyVideoModel(command.Key) {
		return invalid("模型配置键无效")
	}
	if remove {
		return nil
	}
	if command.Enabled == nil || command.Visible == nil || command.HomepageVisible == nil || command.HomepagePriority == nil || command.Description == nil || command.CoverChange == nil {
		return invalid("模型展示配置字段不完整")
	}
	*command.Description = strings.TrimSpace(*command.Description)
	if *command.HomepagePriority < 0 || *command.HomepagePriority > 10000 || len(utf16.Encode([]rune(*command.Description))) > 200 || (*command.HomepageVisible && !*command.Visible) {
		return invalid("模型展示配置无效")
	}
	if command.IconKey != "" && !containsString([]string{"openai", "google", "bytedance", "kling", "runway", "xai", "generic"}, command.IconKey) {
		return invalid("模型图标无效")
	}
	if !containsString([]string{"keep", "remove", "replace"}, command.CoverChange.Action) || (command.CoverChange.Action != "replace" && len(command.CoverChange.Bytes) > 0) {
		return invalid("封面动作无效")
	}
	if command.IsCustom && (strings.ToLower(command.Key) != command.Key || !videoSafeLabel.MatchString(command.Key) || strings.HasPrefix(command.Key, "firefly-") || command.Key == "auto" || command.Key == "unknown") {
		return invalid("自定义模型ID无效")
	}
	if len(command.SupportedResolutions) > 20 {
		return invalid("最多支持20种分辨率")
	}
	seen := map[string]bool{}
	for i, res := range command.SupportedResolutions {
		res = strings.TrimSpace(res)
		key := strings.ToLower(res)
		if len(res) > 32 || !videoSafeLabel.MatchString(res) || seen[key] {
			return invalid("模型分辨率无效或重复")
		}
		seen[key] = true
		command.SupportedResolutions[i] = res
	}
	if command.MaxReferenceImages != nil && (*command.MaxReferenceImages < 0 || *command.MaxReferenceImages > 9007199254740991) {
		return invalid("参考图上限无效")
	}
	prices := []map[string]float64{command.Pricing, command.CreditsPerSecond, command.CreditsPerItem}
	for _, prices := range prices {
		for _, price := range prices {
			if math.IsNaN(price) || math.IsInf(price, 0) || price <= 0 || price > 100000 {
				return invalid("价格必须大于0且不超过100000")
			}
		}
	}
	if command.Category == "image" {
		if command.BillingMode != "" || command.CreditsPerSecond != nil || command.CreditsPerItem != nil || command.OutputSizes != nil {
			return invalid("图像模型不能设置视频计费或输出像素")
		}
		if len(command.Pricing) == 0 {
			return invalid("图像价格不能为空")
		}
		for key := range command.Pricing {
			if !containsString([]string{"base1024Credits", "base1kCredits", "base2kCredits", "base4kCredits", "base8kCredits"}, key) {
				return invalid("图像价格字段无效")
			}
		}
		if !command.IsCustom {
			for _, key := range []string{"base1024Credits", "base1kCredits", "base2kCredits", "base4kCredits"} {
				if command.Pricing[key] <= 0 {
					return invalid("图像模型必须配置完整价格")
				}
			}
		}
		for res, key := range map[string]string{"1k": "base1kCredits", "2k": "base2kCredits", "4k": "base4kCredits", "8k": "base8kCredits"} {
			if seen[res] && command.Pricing[key] <= 0 {
				return invalid("支持的图像分辨率缺少价格: " + res)
			}
		}
		if command.IsCustom && len(command.SupportedResolutions) == 0 {
			return invalid("自定义图像模型必须声明分辨率")
		}
	} else {
		if command.Pricing != nil || command.SupportsQuality != nil {
			return invalid("视频模型不能设置图像价格或质量参数")
		}
		if command.BillingMode != "per_second" && command.BillingMode != "per_item" {
			return invalid("视频计费模式无效")
		}
		if len(command.CreditsPerSecond) == 0 || len(command.CreditsPerSecond) != len(command.CreditsPerItem) {
			return invalid("视频两种计费价格必须覆盖相同分辨率")
		}
		for res := range command.CreditsPerSecond {
			if command.CreditsPerItem[res] <= 0 {
				return invalid("视频按条价格不完整")
			}
		}
		if command.IsCustom && len(command.SupportedResolutions) == 0 {
			for res := range command.CreditsPerSecond {
				command.SupportedResolutions = append(command.SupportedResolutions, res)
			}
			sort.Strings(command.SupportedResolutions)
		}
	}
	return nil
}

func (b *backend) applyModelConfiguration(ctx context.Context, actor string, command modelConfigurationCommand, remove bool) (map[string]any, error) {
	if err := validateModelConfigurationCommand(&command, remove); err != nil {
		return nil, err
	}
	var coverData []byte
	var coverKey string
	if !remove && command.CoverChange.Action == "replace" {
		var err error
		coverData, coverKey, err = prepareModelCover(command.Category, command.Key, command.CoverChange.Bytes)
		if err != nil {
			return nil, err
		}
	}
	bucket, _, err := b.storageBuckets(ctx)
	if err != nil {
		return nil, err
	}
	payload := command
	if command.CoverChange != nil {
		copy := *command.CoverChange
		copy.Bytes = nil
		payload.CoverChange = &copy
	}
	digest := sha256.Sum256([]byte(mustJSON(map[string]any{"command": payload, "remove": remove, "coverKey": coverKey})))
	requestHash := hex.EncodeToString(digest[:])
	receiptDigest := sha256.Sum256([]byte(mustJSON([]string{actor, command.ClientRequestID})))
	receiptKey := hex.EncodeToString(receiptDigest[:])
	auditID := "model-config:" + receiptKey
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	// Same global settings lock as settings bootstrap/update, followed by row locks
	// in a stable order: two models cannot overwrite one another's financial maps.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('system-settings:bootstrap'))`); err != nil {
		return nil, err
	}
	settings, err := lockModelConfigurationSettings(ctx, tx)
	if err != nil {
		return nil, err
	}
	config := settings["MODEL_MARKETPLACE_CONFIG"]
	var priorHash string
	var priorResult []byte
	err = tx.QueryRow(ctx, `SELECT metadata->>'requestHash',after FROM admin_audit_log WHERE id=$1`, auditID).Scan(&priorHash, &priorResult)
	if err == nil {
		if priorHash != requestHash {
			return nil, &apiError{409, "IDEMPOTENCY_CONFLICT", "该请求标识已用于另一份模型配置"}
		}
		var result map[string]any
		if json.Unmarshal(priorResult, &result) != nil {
			return nil, errors.New("Invalid model receipt")
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err = validateModelConfigurationCovers(config, bucket); err != nil {
		return nil, err
	}
	section := "imageByModel"
	if command.Category == "video" {
		section = "videoByFamily"
	}
	entries := goMapObject(config, section)
	previous := goMapObject(entries, command.Key)
	if revision := goInt64(previous["revision"]); revision != *command.ExpectedRevision {
		return nil, &apiError{409, "REVISION_CONFLICT", "模型配置已被其他管理员更新"}
	}
	customModels, _ := config["customModels"].([]any)
	customIndex := -1
	for i, raw := range customModels {
		entry, _ := raw.(map[string]any)
		if strings.EqualFold(stringValue(entry["modelId"]), command.Key) {
			if entry["category"] != command.Category {
				return nil, invalid("模型ID已被其他媒体类别使用")
			}
			customIndex = i
		}
	}
	if remove && customIndex < 0 {
		return nil, invalid("只能删除自定义模型")
	}
	if !remove {
		if err = validateModelConfigurationTarget(ctx, tx, settings, &command, customIndex >= 0); err != nil {
			return nil, err
		}
	}
	result := map[string]any{"category": command.Category, "configKey": command.Key}
	oldCover := previous["cover"]
	if remove {
		delete(entries, command.Key)
		config["customModels"] = append(customModels[:customIndex], customModels[customIndex+1:]...)
		if command.Category == "image" {
			delete(goMapObject(settings["IMAGE_MODEL_CREDIT_PRICES"], "byModel"), command.Key)
		} else {
			removeVideoModelPrices(settings, command.Key)
			delete(settings["VIDEO_MODEL_BILLING_MODES"], command.Key)
			delete(goMapObject(settings["VIDEO_MODEL_CAPABILITY_OVERRIDES"], "byModel"), command.Key)
		}
	} else {
		revision := *command.ExpectedRevision + 1
		result["revision"] = revision
		next := map[string]any{"revision": revision, "enabled": *command.Enabled, "visible": *command.Visible, "homepageVisible": *command.HomepageVisible, "homepagePriority": *command.HomepagePriority, "description": *command.Description, "cover": oldCover}
		if command.IconKey != "" {
			next["iconKey"] = command.IconKey
		} else if previous["iconKey"] != nil {
			next["iconKey"] = previous["iconKey"]
		}
		if len(command.SupportedResolutions) > 0 {
			next["supportedResolutions"] = command.SupportedResolutions
		}
		if command.CoverChange.Action == "remove" {
			next["cover"] = nil
		}
		if command.CoverChange.Action == "replace" {
			next["cover"] = map[string]any{"bucket": bucket, "key": coverKey}
		}
		if command.Category == "image" {
			if command.SupportsQuality != nil && *command.SupportsQuality {
				next["supportsQuality"] = true
			}
			if command.MaxReferenceImages != nil {
				next["maxReferenceImages"] = *command.MaxReferenceImages
			}
			persistImageModelPrices(settings, command)
		} else {
			removeVideoModelPrices(settings, command.Key)
			maximum := 0.0
			for res, price := range command.CreditsPerSecond {
				settings["VIDEO_MODEL_CREDITS_PER_SECOND"][command.Key+"@"+strings.ToLower(res)] = price
				if price > maximum {
					maximum = price
				}
			}
			settings["VIDEO_MODEL_CREDITS_PER_SECOND"][command.Key] = maximum
			for res, price := range command.CreditsPerItem {
				settings["VIDEO_MODEL_CREDITS_PER_ITEM"][command.Key+"@"+strings.ToLower(res)] = price
			}
			settings["VIDEO_MODEL_BILLING_MODES"][command.Key] = command.BillingMode
			if command.MaxReferenceImages != nil {
				goMapObject(settings["VIDEO_MODEL_CAPABILITY_OVERRIDES"], "byModel")[command.Key] = map[string]any{"maxReferenceImages": *command.MaxReferenceImages}
			}
		}
		entries[command.Key] = next
		if command.IsCustom || customIndex >= 0 {
			var custom map[string]any
			if customIndex >= 0 {
				custom = customModels[customIndex].(map[string]any)
			} else {
				custom = map[string]any{"modelId": command.Key, "category": command.Category}
			}
			if len(command.SupportedResolutions) > 0 {
				custom["supportedResolutions"] = command.SupportedResolutions
			}
			if command.OutputSizes != nil {
				custom["outputSizesByResolution"] = command.OutputSizes
			}
			if command.Category == "image" {
				delete(custom, "supportsQuality")
				delete(custom, "maxReferenceImages")
				if next["supportsQuality"] != nil {
					custom["supportsQuality"] = true
				}
				if next["maxReferenceImages"] != nil {
					custom["maxReferenceImages"] = next["maxReferenceImages"]
				}
			}
			if customIndex < 0 {
				customModels = append(customModels, custom)
			} else {
				customModels[customIndex] = custom
			}
			config["customModels"] = customModels
		}
	}
	committed := false
	defer func() {
		if !committed && coverData != nil && stringValue(goMapObject(previous, "cover")["key"]) != coverKey {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = b.deleteStorageObject(cleanupCtx, bucket, coverKey)
		}
	}()
	if coverData != nil {
		if err = b.putStorageObject(ctx, bucket, coverKey, coverData, "image/webp"); err != nil {
			return nil, err
		}
	}
	config[section] = entries
	config["version"] = 2
	receipts := goMapObject(config, "writeReceipts")
	receipts[receiptKey] = map[string]any{"requestHash": requestHash, "category": command.Category, "configKey": command.Key, "resultingRevision": goInt64(result["revision"]), "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	pruneModelReceipts(receipts)
	config["writeReceipts"] = receipts
	for _, key := range modelConfigurationSettingKeys {
		if _, err = writeSystemSetting(ctx, tx, systemSettingDefinitionByKey[key], settings[key], actor, true); err != nil {
			return nil, err
		}
	}
	action := "modelConfiguration.update"
	if remove {
		action = "modelConfiguration.delete"
	}
	if _, err = tx.Exec(ctx, `INSERT INTO admin_audit_log(id,admin_user_id,action,reason,before,after,metadata) VALUES($1,$2,$3,'管理员修改模型配置',$4,$5,$6)`, auditID, actor, action, mustJSON(map[string]any{"category": command.Category, "configKey": command.Key, "revision": *command.ExpectedRevision}), mustJSON(result), mustJSON(map[string]any{"requestHash": requestHash, "coverAction": func() string {
		if remove {
			return "remove"
		}
		return command.CoverChange.Action
	}()})); err != nil {
		return nil, err
	}
	if oldCover != nil && (remove || (!remove && command.CoverChange.Action != "keep")) && !modelCoverReferenced(config, oldCover) {
		if _, err = tx.Exec(ctx, `INSERT INTO admin_audit_log(id,admin_user_id,action,reason,metadata) VALUES($1,$2,'modelConfiguration.coverCleanup','回收旧模型封面',$3)`, newRequestID(), actor, mustJSON(oldCover)); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	committed = true
	_ = b.cleanupModelConfigurationCovers(ctx)
	return result, nil
}

func lockModelConfigurationSettings(ctx context.Context, tx pgx.Tx) (map[string]map[string]any, error) {
	keys := append([]string(nil), modelConfigurationSettingKeys...)
	sort.Strings(keys)
	result := map[string]map[string]any{}
	for _, key := range keys {
		def := systemSettingDefinitionByKey[key]
		if _, err := tx.Exec(ctx, `INSERT INTO system_setting(key,value,is_secret) VALUES($1,$2,false) ON CONFLICT(key) DO NOTHING`, key, mustJSON(def.DefaultValue)); err != nil {
			return nil, err
		}
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT value FROM system_setting WHERE key=$1 FOR UPDATE`, key).Scan(&raw); err != nil {
			return nil, err
		}
		var value any
		if json.Unmarshal(raw, &value) != nil {
			return nil, invalid("模型设置数据损坏")
		}
		object, err := decodeModelSetting(value)
		if err != nil {
			return nil, err
		}
		result[key] = object
	}
	config := result["MODEL_MARKETPLACE_CONFIG"]
	for _, section := range []string{"imageByModel", "videoByFamily", "writeReceipts"} {
		if config[section] == nil {
			config[section] = map[string]any{}
		}
		if _, ok := config[section].(map[string]any); !ok {
			return nil, invalid("模型配置格式无效")
		}
	}
	if config["customModels"] == nil {
		config["customModels"] = []any{}
	}
	if _, ok := config["customModels"].([]any); !ok {
		return nil, invalid("自定义模型目录格式无效")
	}
	delete(config, "fallbackImagePricingRevision")
	if result["IMAGE_MODEL_CREDIT_PRICES"]["byModel"] == nil {
		result["IMAGE_MODEL_CREDIT_PRICES"]["version"] = 1
		result["IMAGE_MODEL_CREDIT_PRICES"]["byModel"] = map[string]any{}
	}
	if result["VIDEO_MODEL_CAPABILITY_OVERRIDES"]["byModel"] == nil {
		result["VIDEO_MODEL_CAPABILITY_OVERRIDES"]["version"] = 1
		result["VIDEO_MODEL_CAPABILITY_OVERRIDES"]["byModel"] = map[string]any{}
	}
	return result, nil
}

func removeVideoModelPrices(settings map[string]map[string]any, key string) {
	for _, name := range []string{"VIDEO_MODEL_CREDITS_PER_SECOND", "VIDEO_MODEL_CREDITS_PER_ITEM"} {
		for priceKey := range settings[name] {
			if priceKey == key || strings.HasPrefix(priceKey, key+"@") {
				delete(settings[name], priceKey)
			}
		}
	}
}

func persistImageModelPrices(settings map[string]map[string]any, command modelConfigurationCommand) {
	byModel := goMapObject(settings["IMAGE_MODEL_CREDIT_PRICES"], "byModel")
	fallback, _ := byModel[command.Key].(map[string]any)
	if fallback == nil {
		fallback, _ = byModel["gpt-image-2"].(map[string]any)
	}
	if fallback == nil {
		fallback = goMapObject(goMapObject(systemSettingDefinitionByKey["IMAGE_MODEL_CREDIT_PRICES"].DefaultValue, "byModel"), "gpt-image-2")
	}
	prices := map[string]any{}
	for _, field := range []string{"base1024Credits", "base1kCredits", "base2kCredits", "base4kCredits"} {
		value := command.Pricing[field]
		if value <= 0 {
			alternate := "base1kCredits"
			if field == "base1kCredits" {
				alternate = "base1024Credits"
			}
			if field == "base4kCredits" {
				alternate = "base2kCredits"
			}
			value = command.Pricing[alternate]
		}
		if value <= 0 {
			value = positiveNumber(fallback[field], 0)
		}
		prices[field] = value
	}
	if price := command.Pricing["base8kCredits"]; price > 0 {
		prices["base8kCredits"] = price
	}
	byModel[command.Key] = prices
}

func pruneModelReceipts(receipts map[string]any) {
	if len(receipts) <= 256 {
		return
	}
	keys := make([]string, 0, len(receipts))
	for key := range receipts {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := goMapObject(receipts, keys[i]), goMapObject(receipts, keys[j])
		if a["completedAt"] == b["completedAt"] {
			return keys[i] < keys[j]
		}
		return stringValue(a["completedAt"]) < stringValue(b["completedAt"])
	})
	for _, key := range keys[:len(keys)-256] {
		delete(receipts, key)
	}
}
