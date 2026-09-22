package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

func (b *backend) registerVideoUOLRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/internal/video/capabilities", b.endpoint(b.handleInternalVideoCapabilities))
	mux.HandleFunc("POST /api/internal/video/generate", b.endpoint(b.handleInternalVideoGenerate))
	mux.HandleFunc("POST /api/internal/video/status", b.endpoint(b.handleInternalVideoStatus))
	mux.HandleFunc("POST /api/internal/video/inputs", b.endpoint(b.handleInternalVideoInputs))
	mux.HandleFunc("POST /api/internal/video/gemini", b.endpoint(b.handleInternalVideoGemini))
	mux.HandleFunc("POST /api/internal/video/gemini/status", b.endpoint(b.handleInternalVideoGeminiStatus))
	mux.HandleFunc("POST /api/internal/video/account-input-cleanup", b.endpoint(b.handleInternalVideoCleanup))
}

func (b *backend) handleInternalVideoCapabilities(w http.ResponseWriter, r *http.Request) error {
	userID, keyID, scope, err := b.internalVideoPrincipal(r)
	if err != nil {
		return err
	}
	return b.writeGoVideoCapabilities(w, r, userID, keyID, scope)
}
func (b *backend) internalVideoPrincipal(r *http.Request) (string, string, string, error) {
	if p, ok := b.signedInternalPrincipal(r); ok {
		if p.Type == "apiKey" {
			if p.CredentialKind != "external" {
				return "", "", "", forbidden()
			}
			if _, err := b.authenticateAPI(r); err != nil {
				return "", "", "", err
			}
			return p.UserID, p.APIKeyID, "external:" + p.UserID + ":" + p.APIKeyID, nil
		}
		return p.UserID, "", "user:" + p.UserID, nil
	}
	s, e := b.requireSession(r)
	if e != nil {
		return "", "", "", e
	}
	return s.User.ID, "", "user:" + s.User.ID, nil
}

func (b *backend) writeGoVideoCapabilities(w http.ResponseWriter, r *http.Request, userID, keyID, scope string) error {
	requestedGroup := r.URL.Query().Get("backendGroupId")
	if r.Method == http.MethodPost && r.ContentLength != 0 {
		var input struct {
			BackendGroupID string `json:"backendGroupId"`
		}
		if err := decodeBody(r, &input); err != nil {
			return err
		}
		requestedGroup = input.BackendGroupID
	}
	pricing, err := b.loadGoVideoPricingContext(r.Context(), userID, keyID, requestedGroup)
	if err != nil {
		return err
	}
	items := make([]map[string]any, 0, len(pricing.Models))
	models := append([]string(nil), videoModelIDs...)
	custom := []string{}
	for model, cfg := range pricing.Models {
		if cfg.Custom {
			custom = append(custom, model)
		}
	}
	sort.Strings(custom)
	models = append(models, custom...)
modelsLoop:
	for _, model := range models {
		cfg, ok := pricing.Models[model]
		if !ok || !cfg.Enabled {
			continue
		}
		capability := cfg.Capability
		billing := make([]map[string]any, 0, len(cfg.SupportedResolutions))
		for _, resolution := range cfg.SupportedResolutions {
			quote, quoteErr := resolveGoVideoQuoteFromContext(pricing, model, resolution, 1)
			if quoteErr != nil {
				var pricingError *apiError
				if errors.As(quoteErr, &pricingError) && pricingError.code == "VIDEO_PRICING_NOT_CONFIGURED" {
					continue modelsLoop
				}
				return quoteErr
			}
			// Capability discovery signs the exact same digest checked by generate.
			token, tokenErr := encodeGoVideoQuoteToken(scope, quote.Digest)
			if tokenErr != nil {
				return tokenErr
			}
			current := map[string]any{"kind": "current_quote", "resolution": resolution, "mode": quote.Mode, "unit": quote.Unit, "unitPrice": quote.UnitPrice, "quoteToken": token}
			if quote.Mode == "per_second" {
				current["creditsPerSecond"] = quote.UnitPrice
			}
			billing = append(billing, current)
		}
		items = append(items, map[string]any{
			"model": model, "displayName": capability.Display, "durations": capability.Durations,
			"aspectRatios": capability.Ratios, "resolutions": cfg.SupportedResolutions,
			"input": map[string]any{"frames": capability.Frames, "referenceImages": map[string]any{"maxCount": capability.RefMax, "configurable": capability.RefConfig}, "framesAndReferencesMutuallyExclusive": true},
			"audio": map[string]any{"supported": capability.Audio, "defaultEnabled": capability.AudioDefault}, "configuredReachable": pricing.Reachable[model], "billing": billing,
		})
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "limits": map[string]any{"maxMediaInputCount": 256, "maxMediaInputBytes": 512 * 1024 * 1024}})
	return nil
}

func encodeGoVideoQuoteToken(scope, digest string) (string, error) {
	secret := strings.TrimSpace(os.Getenv("BETTER_AUTH_SECRET"))
	if secret == "" {
		return "", errors.New("Video quote validation is not configured")
	}
	payload, err := json.Marshal(struct {
		V     int    `json:"v"`
		Sub   string `json:"sub"`
		Quote string `json:"quote"`
	}{1, scope, digest})
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("fluxmedia:video-quote:v1"))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func videoUOLStatus(status, stage string) string {
	if status == "completed" {
		return "completed"
	}
	if status == "failed" {
		return "failed"
	}
	if stage == "created" || stage == "queued" {
		return "queued"
	}
	return "in_progress"
}
func videoUOLBilling(credits float64) map[string]any {
	return map[string]any{"kind": "legacy", "mode": "per_second", "unit": "second", "unitPrice": nil, "creditsPerSecond": nil, "quotedCredits": nil, "actualCredits": credits}
}
func (b *backend) handleInternalVideoGenerate(w http.ResponseWriter, r *http.Request) error {
	userID, keyID, scope, err := b.internalVideoPrincipal(r)
	if err != nil {
		return err
	}
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	task, err := b.createNativeVideoTask(r, userID, keyID, scope, body)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 200, videoGenerateResult(task))
	return nil
}
func (b *backend) handleInternalVideoStatus(w http.ResponseWriter, r *http.Request) error {
	userID, keyID, scope, err := b.internalVideoPrincipal(r)
	if err != nil {
		return err
	}
	var input struct {
		TaskID string `json:"taskId"`
	}
	if err = decodeBody(r, &input); err != nil {
		return err
	}
	task, err := b.readNativeVideoStatus(r, input.TaskID, userID, keyID, scope)
	if err != nil {
		return err
	}
	delete(task, "geminiOperationId")
	noStore(w)
	writeJSON(w, 200, task)
	return nil
}
func (b *backend) handleInternalVideoInputs(w http.ResponseWriter, r *http.Request) error {
	userID, keyID, scope, e := b.internalVideoPrincipal(r)
	if e != nil {
		return e
	}
	body, e := decodeObject(r)
	if e != nil {
		return e
	}
	taskID := rawString(body, "taskId", "task_id")
	if taskID == "" {
		return invalid("taskId is required")
	}
	var manifest []byte
	e = b.db.QueryRow(r.Context(), `SELECT input_manifest FROM video_generation WHERE id=$1 AND user_id=$2 AND principal_scope=$3 AND (api_key_id IS NOT DISTINCT FROM NULLIF($4,''))`, taskID, userID, scope, keyID).Scan(&manifest)
	if e == pgx.ErrNoRows {
		return &apiError{404, "NOT_FOUND", "Video task not found"}
	}
	if e != nil {
		return e
	}
	var decoded map[string]any
	if json.Unmarshal(manifest, &decoded) != nil {
		return errors.New("Invalid video input manifest")
	}
	out, e := b.videoInputAssets(r, userID, taskID, decoded)
	if e != nil {
		return e
	}
	noStore(w)
	writeJSON(w, 200, out)
	return nil
}
func (b *backend) handleInternalVideoGemini(w http.ResponseWriter, r *http.Request) error {
	return b.handleInternalVideoGenerate(w, r)
}
func (b *backend) handleInternalVideoGeminiStatus(w http.ResponseWriter, r *http.Request) error {
	userID, keyID, scope, e := b.internalVideoPrincipal(r)
	if e != nil {
		return e
	}
	body, e := decodeObject(r)
	if e != nil {
		return e
	}
	operationName := rawString(body, "operationName", "operation_name")
	parts := strings.Split(operationName, "/")
	model := rawString(body, "model")
	if len(parts) != 4 || parts[0] != "models" || parts[2] != "operations" || parts[1] != model {
		return &apiError{404, "NOT_FOUND", "Operation not found"}
	}
	result, e := b.readNativeGeminiOperation(r, userID, keyID, scope, model, parts[3])
	if e != nil {
		return e
	}
	noStore(w)
	writeJSON(w, 200, result)
	return nil
}
func (b *backend) handleInternalVideoCleanup(w http.ResponseWriter, r *http.Request) error {
	userID, _, _, e := b.internalVideoPrincipal(r)
	if e != nil {
		return e
	}
	body, e := decodeObject(r)
	if e != nil {
		return e
	}
	requestID := rawString(body, "clientRequestId", "client_request_id")
	if requestID == "" {
		return invalid("clientRequestId is required")
	}
	// Register every persisted storage reference as a lifecycle cleanup intent.
	// The maintenance worker only deletes these rows after the account has been
	// marked deleted, so requesting cleanup is safe before the account transaction
	// commits and is idempotent across retries.
	rows, err := b.db.Query(r.Context(), `SELECT id,input_manifest FROM video_generation WHERE user_id=$1`, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	queued := 0
	for rows.Next() {
		var videoID string
		var manifest []byte
		if err := rows.Scan(&videoID, &manifest); err != nil {
			return err
		}
		var value any
		if json.Unmarshal(manifest, &value) != nil {
			return invalid("视频输入清单无效")
		}
		for _, ref := range collectVideoStorageRefs(value) {
			prefix := userID + "/video-inputs/" + videoID + "/"
			if !strings.HasPrefix(ref.key, prefix) {
				continue
			}
			attempt := strings.TrimPrefix(ref.key, prefix)
			if len(strings.Split(attempt, "/")) != 2 {
				continue
			}
			idDigest := sha256.Sum256([]byte(userID + "\x00lifecycle_delete\x00" + videoID + "\x00" + attempt + "\x00" + ref.bucket + "\x00" + ref.key))
			_, err := b.db.Exec(r.Context(), `INSERT INTO video_input_cleanup(id,user_id,video_id,attempt_id,storage_key,storage_bucket,reason,next_attempt_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'lifecycle_delete',now(),now()) ON CONFLICT(id) DO NOTHING`, hex.EncodeToString(idDigest[:]), userID, videoID, strings.Split(attempt, "/")[0], ref.key, ref.bucket)
			if err != nil {
				return err
			}
			queued++
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	requestDigest := sha256.Sum256([]byte(userID + "\x00" + requestID))
	writeJSON(w, 200, map[string]any{"cleanupRequestId": hex.EncodeToString(requestDigest[:]), "status": "queued", "objectsQueued": queued})
	return nil
}

type videoStorageRef struct{ key, bucket string }

type goVideoQuote struct {
	Mode, Unit        string
	UnitPrice, Quoted float64
	Snapshot          map[string]any
	Digest            string
	Revision          int64
	GroupID           string
	SupportedRes      []string
	MaxReference      int
	CustomModel       bool
}

// assertGoVideoQuoteToken validates the signed principal binding. The digest is
// deliberately opaque; the authoritative quote above is persisted atomically
// and remains the source of the task billing snapshot.
func assertGoVideoQuoteToken(token, principalScope, expectedDigest string) error {
	if token == "" || len(token) > 2048 {
		return errors.New("Invalid or stale video quote token")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 || token == "" {
		return errors.New("Invalid or stale video quote token")
	}
	for _, part := range parts {
		if part == "" || strings.ContainsAny(part, "=+/\r\n\t ") {
			return errors.New("Invalid or stale video quote token")
		}
	}
	secret := strings.TrimSpace(os.Getenv("BETTER_AUTH_SECRET"))
	if secret == "" {
		return errors.New("Video quote validation is not configured")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("fluxmedia:video-quote:v1"))
	mac.Write([]byte{0})
	mac.Write([]byte(parts[0]))
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return errors.New("Invalid or stale video quote token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return errors.New("Invalid or stale video quote token")
	}
	var raw map[string]any
	if json.Unmarshal(payload, &raw) != nil || len(raw) != 3 {
		return errors.New("Invalid or stale video quote token")
	}
	for key := range raw {
		if key != "v" && key != "sub" && key != "quote" {
			return errors.New("Invalid or stale video quote token")
		}
	}
	var body struct {
		V     int    `json:"v"`
		Sub   string `json:"sub"`
		Quote string `json:"quote"`
	}
	if json.Unmarshal(payload, &body) != nil || body.V != 1 || body.Sub != principalScope || len(body.Quote) != 64 || (expectedDigest != "" && body.Quote != expectedDigest) {
		return errors.New("Invalid or stale video quote token")
	}
	for _, c := range body.Quote {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return errors.New("Invalid or stale video quote token")
		}
	}
	return nil
}

// Capability discovery and task creation use the same persisted pricing data.
type goVideoModelConfig struct {
	Enabled              bool
	Revision             int64
	SupportedResolutions []string
	BillingMode          string
	Custom               bool
	Capability           goVideoCapability
	OutputSizes          any
}

type goVideoPricingContext struct {
	Settings          map[string]map[string]any
	Models            map[string]goVideoModelConfig
	GroupID           string
	GroupPerSec       map[string]float64
	GroupPerItem      map[string]float64
	Reachable         map[string]bool
	Group             imageGroupSnapshot
	ModerationEnabled bool
}

// The static capability catalog is intentionally kept in the Go boundary. It
// mirrors packages/shared/video-generation/capability-catalog.ts and is only
// used as the fallback when MODEL_MARKETPLACE_CONFIG has no resolution list.
type goVideoCapability struct {
	Display      string
	Durations    []int
	Ratios       []string
	Resolutions  []string
	Frames       string
	RefMax       int
	RefConfig    bool
	Audio        bool
	AudioDefault bool
}

var goVideoCapabilities = map[string]goVideoCapability{
	"sora2":          {"Sora 2", []int{4, 8, 12}, []string{"9:16", "16:9"}, []string{"720p"}, "first-only", 0, false, false, false},
	"sora2-pro":      {"Sora 2 Pro", []int{4, 8, 12}, []string{"9:16", "16:9"}, []string{"720p"}, "first-only", 0, false, false, false},
	"veo31":          {"Veo 3.1", []int{4, 6, 8}, []string{"16:9", "9:16"}, []string{"1080p", "720p"}, "first-and-optional-last", 0, false, false, false},
	"veo31-fast":     {"Veo 3.1 Fast", []int{4, 6, 8}, []string{"16:9", "9:16"}, []string{"1080p", "720p"}, "first-and-optional-last", 0, false, false, false},
	"veo31-ref":      {"Veo 3.1 Reference", []int{4, 6, 8}, []string{"16:9", "9:16"}, []string{"1080p", "720p"}, "none", 3, false, false, false},
	"kling-o3":       {"Kling O3", []int{5, 15}, []string{"16:9", "9:16"}, []string{"1080p"}, "first-and-optional-last", 0, false, false, false},
	"kling3":         {"Kling 3.0", []int{3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, []string{"16:9", "9:16"}, []string{"1080p", "720p"}, "first-and-optional-last", 0, false, true, true},
	"kling3-omni":    {"Kling 3.0 Omni", []int{3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, []string{"16:9", "9:16"}, []string{"1080p", "720p"}, "first-and-optional-last", 3, false, true, false},
	"runway-gen45":   {"Runway Gen-4.5", []int{5, 8, 10}, []string{"16:9"}, []string{"720p"}, "none", 0, false, false, false},
	"ray314":         {"Ray 3.14", []int{5, 10}, []string{"1:1", "4:3", "3:4", "16:9", "9:16", "21:9"}, []string{"4k", "1080p", "720p"}, "none", 0, false, false, false},
	"ray314-hdr":     {"Ray 3.14 HDR", []int{5}, []string{"1:1", "4:3", "3:4", "16:9", "9:16", "21:9"}, []string{"4k", "1080p", "720p"}, "none", 0, false, false, false},
	"seedance2":      {"Seedance 2.0", []int{4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, []string{"1:1", "4:3", "3:4", "16:9", "9:16", "21:9"}, []string{"1080p", "720p", "480p"}, "first-and-optional-last", 10, true, true, false},
	"seedance2-fast": {"Seedance 2.0 Fast", []int{4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, []string{"1:1", "4:3", "3:4", "16:9", "9:16", "21:9"}, []string{"720p", "480p"}, "first-and-optional-last", 10, true, true, false},
}

func goNumberMap(value any) map[string]float64 {
	result := map[string]float64{}
	obj, _ := value.(map[string]any)
	for key, raw := range obj {
		if n, ok := raw.(float64); ok && n > 0 && n <= 100000 {
			result[strings.ToLower(strings.TrimSpace(key))] = n
		}
	}
	return result
}

func goStringSlice(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
			result = append(result, strings.TrimSpace(s))
		}
	}
	return result
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func goMapObject(value any, key string) map[string]any {
	obj, _ := value.(map[string]any)
	child, _ := obj[key].(map[string]any)
	return child
}

func goInt64(value any) int64 {
	switch n := value.(type) {
	case float64:
		if n >= 0 && n <= math.MaxInt64 && math.Trunc(n) == n {
			return int64(n)
		}
	case json.Number:
		if parsed, err := n.Int64(); err == nil && parsed >= 0 {
			return parsed
		}
	case int64:
		if n >= 0 {
			return n
		}
	case int:
		if n >= 0 {
			return int64(n)
		}
	}
	return 0
}

type videoPricingStore interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (b *backend) loadGoVideoPricingContext(ctx context.Context, userID, keyID, requestedGroup string) (goVideoPricingContext, error) {
	return loadGoVideoPricingContext(ctx, b.db, userID, keyID, requestedGroup)
}
func loadGoVideoPricingContext(ctx context.Context, database videoPricingStore, userID, keyID, requestedGroup string) (goVideoPricingContext, error) {
	var settingsRaw, groupsRaw, membersRaw []byte
	var apiGroup *string
	var keyExists bool
	err := database.QueryRow(ctx, `
 SELECT COALESCE((SELECT jsonb_object_agg(key,value) FROM system_setting WHERE key IN ('MODEL_MARKETPLACE_CONFIG','VIDEO_MODEL_BILLING_MODES','VIDEO_MODEL_CREDITS_PER_SECOND','VIDEO_MODEL_CREDITS_PER_ITEM','VIDEO_MODEL_CAPABILITY_OVERRIDES','CONTENT_MODERATION_ENABLED')),'{}'::jsonb),
 (SELECT generation_group_id FROM external_api_key WHERE id=NULLIF($1,'') AND user_id=$2 AND is_active),
 EXISTS(SELECT 1 FROM external_api_key WHERE id=NULLIF($1,'') AND user_id=$2 AND is_active),
 COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM (SELECT id,name,priority,content_safety_enabled AS "contentSafetyEnabled",is_default AS "isDefault",is_user_selectable AS "isUserSelectable",metadata FROM image_backend_group WHERE is_enabled ORDER BY created_at,id) g),'[]'::jsonb),
 COALESCE((SELECT jsonb_agg(jsonb_build_object('groupId',mg.group_id,'models',m.supported_model_ids)) FROM image_backend_member_group mg JOIN image_backend_member m ON m.id=mg.member_id JOIN image_backend_member_api_config c ON c.member_id=m.id JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id AND v.member_id_snapshot=m.id AND v.credential_scope=c.credential_scope WHERE m.is_enabled AND m.type='api' AND v.configuration::jsonb->'operations' ? 'videos.generate'),'[]'::jsonb)
 `, keyID, userID).Scan(&settingsRaw, &apiGroup, &keyExists, &groupsRaw, &membersRaw)
	if err != nil {
		return goVideoPricingContext{}, err
	}
	var settings map[string]any
	if json.Unmarshal(settingsRaw, &settings) != nil {
		return goVideoPricingContext{}, errors.New("Invalid video pricing settings")
	}
	result := goVideoPricingContext{Settings: map[string]map[string]any{}, Models: map[string]goVideoModelConfig{}, GroupPerSec: map[string]float64{}, GroupPerItem: map[string]float64{}, Reachable: map[string]bool{}, ModerationEnabled: true}
	for key, value := range settings {
		if encoded, ok := value.(string); ok {
			var decoded any
			if json.Unmarshal([]byte(encoded), &decoded) != nil {
				return result, errors.New("Invalid video settings JSON")
			}
			settings[key] = decoded
		}
	}
	for key, value := range settings {
		if key == "CONTENT_MODERATION_ENABLED" {
			var ok bool
			result.ModerationEnabled, ok = value.(bool)
			if !ok {
				return result, errors.New("Invalid moderation setting")
			}
			continue
		}
		if obj, ok := value.(map[string]any); ok {
			result.Settings[key] = obj
		} else {
			return result, errors.New("Invalid video settings object: " + key)
		}
	}
	if keyID != "" && !keyExists {
		return result, &apiError{401, "UNAUTHORIZED", "API key is invalid or disabled"}
	}
	if keyID != "" && requestedGroup != "" {
		return result, invalid("API keys cannot override their configured group")
	}
	type group struct {
		ID                   string
		Name                 string
		Priority             int
		ContentSafetyEnabled *bool
		IsDefault            bool
		IsUserSelectable     bool
		Metadata             map[string]any
	}
	var groups []group
	if json.Unmarshal(groupsRaw, &groups) != nil {
		return result, errors.New("Invalid video groups")
	}
	target := strings.TrimSpace(requestedGroup)
	if keyID != "" && apiGroup != nil {
		target = strings.TrimSpace(*apiGroup)
	}
	var selected *group
	for i := range groups {
		g := &groups[i]
		if (target != "" && g.ID == target) || (target == "" && g.IsDefault) {
			if selected != nil {
				return result, &apiError{503, "NO_ELIGIBLE_BACKEND_GROUP", "Multiple default media groups"}
			}
			selected = g
		}
	}
	if selected == nil {
		return result, &apiError{503, "NO_ELIGIBLE_BACKEND_GROUP", "No enabled media group"}
	}
	if keyID == "" && requestedGroup != "" && !selected.IsUserSelectable {
		return result, forbidden()
	}
	result.GroupID = selected.ID
	result.Group = imageGroupSnapshot{ID: selected.ID, Name: selected.Name, Priority: selected.Priority, ContentSafetyEnabled: selected.ContentSafetyEnabled}
	result.GroupPerSec = goNumberMap(selected.Metadata["videoCreditOverrides"])
	result.GroupPerItem = goNumberMap(selected.Metadata["videoCreditsPerItemOverrides"])
	var members []struct {
		GroupID string
		Models  []string
	}
	if json.Unmarshal(membersRaw, &members) != nil {
		return result, errors.New("Invalid video group membership")
	}
	groupIDs, err := reachableMediaGroupIDs(ctx, database, result.GroupID)
	if err != nil {
		return result, err
	}
	reachableGroups := map[string]bool{}
	for _, id := range groupIDs {
		reachableGroups[id] = true
	}
	for _, member := range members {
		if reachableGroups[member.GroupID] {
			for _, model := range member.Models {
				result.Reachable[model] = true
			}
		}
	}
	return configureGoVideoModels(result, settings)
}

func configureGoVideoModels(result goVideoPricingContext, settings map[string]any) (goVideoPricingContext, error) {
	overrides := map[string]any{}
	if raw, exists := settings["VIDEO_MODEL_CAPABILITY_OVERRIDES"]; exists {
		value, ok := raw.(map[string]any)
		if !ok || goInt64(value["version"]) != 1 || len(value) != 2 {
			return result, errors.New("Invalid video capability overrides")
		}
		overrides, ok = value["byModel"].(map[string]any)
		if !ok {
			return result, errors.New("Invalid video capability overrides")
		}
		for model, raw := range overrides {
			cap, exists := goVideoCapabilities[model]
			entry, ok := raw.(map[string]any)
			if !exists || !cap.RefConfig || !ok || len(entry) != 1 || goInt64(entry["maxReferenceImages"]) <= 0 {
				return result, errors.New("Invalid video capability override: " + model)
			}
		}
	}
	entries := goMapObject(settings["MODEL_MARKETPLACE_CONFIG"], "videoByFamily")
	for model, capability := range goVideoCapabilities {
		if override, ok := overrides[model].(map[string]any); ok {
			capability.RefMax = int(goInt64(override["maxReferenceImages"]))
		}
		cfg := goVideoModelConfig{Enabled: true, SupportedResolutions: append([]string(nil), capability.Resolutions...), BillingMode: "per_second", Capability: capability}
		cfg = configureGoVideoModel(cfg, entries[model])
		result.Models[model] = cfg
	}
	if marketplace, ok := settings["MODEL_MARKETPLACE_CONFIG"].(map[string]any); ok {
		custom, _ := marketplace["customModels"].([]any)
		for _, raw := range custom {
			entry, ok := raw.(map[string]any)
			if !ok || entry["category"] != "video" {
				continue
			}
			model, _ := entry["modelId"].(string)
			res := goStringSlice(entry["supportedResolutions"])
			if model == "" || len(res) == 0 {
				continue
			}
			cfg := goVideoModelConfig{Enabled: true, Custom: true, SupportedResolutions: res, BillingMode: "per_second", Capability: goVideoCapability{Display: model, Durations: []int{5, 10}, Ratios: videoRatios, Resolutions: res, Frames: "none"}, OutputSizes: entry["outputSizesByResolution"]}
			cfg = configureGoVideoModel(cfg, entries[model])
			result.Models[model] = cfg
		}
	}
	return result, nil
}
func configureGoVideoModel(cfg goVideoModelConfig, raw any) goVideoModelConfig {
	entry, ok := raw.(map[string]any)
	if !ok {
		return cfg
	}
	if enabled, ok := entry["enabled"].(bool); ok {
		cfg.Enabled = enabled
	}
	cfg.Revision = goInt64(entry["revision"])
	if resolutions := goStringSlice(entry["supportedResolutions"]); len(resolutions) > 0 {
		cfg.SupportedResolutions = resolutions
	}
	if mode, ok := entry["billingMode"].(string); ok {
		cfg.BillingMode = mode
	}
	if sizes, ok := entry["outputSizesByResolution"].(map[string]any); ok {
		cfg.OutputSizes = sizes
	}
	return cfg
}
func (b *backend) resolveGoVideoQuote(ctx context.Context, userID, keyID, requestedGroup, model, resolution string, duration int) (goVideoQuote, error) {
	pricing, err := b.loadGoVideoPricingContext(ctx, userID, keyID, requestedGroup)
	if err != nil {
		return goVideoQuote{}, err
	}
	return resolveGoVideoQuoteFromContext(pricing, model, resolution, duration)
}

func resolveGoVideoQuoteFromContext(pricing goVideoPricingContext, model, resolution string, duration int) (goVideoQuote, error) {
	cfg, ok := pricing.Models[model]
	if !ok || !cfg.Enabled {
		return goVideoQuote{}, invalid("Video model is disabled or unconfigured")
	}
	if !containsString(cfg.SupportedResolutions, resolution) || duration <= 0 {
		return goVideoQuote{}, invalid("Unsupported video resolution or duration")
	}
	mode := cfg.BillingMode
	if value, ok := pricing.Settings["VIDEO_MODEL_BILLING_MODES"][model].(string); ok {
		mode = value
	}
	if mode != "per_second" && mode != "per_item" {
		return goVideoQuote{}, invalid("Invalid video billing mode")
	}
	globalSecond := goNumberMap(pricing.Settings["VIDEO_MODEL_CREDITS_PER_SECOND"])
	globalItem := goNumberMap(pricing.Settings["VIDEO_MODEL_CREDITS_PER_ITEM"])
	for _, res := range cfg.SupportedResolutions {
		key := model + "@" + strings.ToLower(res)
		if globalSecond[key] <= 0 || globalItem[key] <= 0 {
			return goVideoQuote{}, &apiError{503, "VIDEO_PRICING_NOT_CONFIGURED", "Video model requires explicit global prices: " + key}
		}
	}
	prices, overrides, unit := globalSecond, pricing.GroupPerSec, "second"
	if mode == "per_item" {
		prices, overrides, unit = globalItem, pricing.GroupPerItem, "item"
	}
	key := model + "@" + strings.ToLower(resolution)
	price := prices[key]
	if value, ok := overrides[model]; ok {
		price = value
	}
	if value, ok := overrides[key]; ok {
		price = value
	}
	quoted := price
	if mode == "per_second" {
		quoted *= float64(duration)
	}
	quoted = math.Ceil(math.Round(quoted*1000000)/10000-1e-9) / 100
	if math.IsInf(quoted, 0) || math.IsNaN(quoted) || quoted <= 0 || quoted > 1e12 {
		return goVideoQuote{}, invalid("Invalid video quoted credits")
	}
	digestPayload := struct {
		ModelID        string  `json:"modelId"`
		Resolution     string  `json:"resolution"`
		Mode           string  `json:"mode"`
		UnitPrice      float64 `json:"unitPrice"`
		BillingGroupID string  `json:"billingGroupId"`
		Revision       int64   `json:"modelConfigurationRevision"`
	}{model, resolution, mode, price, pricing.GroupID, cfg.Revision}
	digest := sha256.Sum256([]byte(mustJSON(digestPayload)))
	snapshotPayload := struct {
		Version         int     `json:"version"`
		ModelID         string  `json:"modelId"`
		Resolution      string  `json:"resolution"`
		Mode            string  `json:"mode"`
		Unit            string  `json:"unit"`
		UnitPrice       float64 `json:"unitPrice"`
		DurationSeconds int     `json:"durationSeconds"`
		QuotedCredits   float64 `json:"quotedCredits"`
		BillingGroupID  string  `json:"billingGroupId"`
	}{1, model, resolution, mode, unit, price, duration, quoted, pricing.GroupID}
	snapshotDigest := sha256.Sum256([]byte(mustJSON(snapshotPayload)))
	snapshot := map[string]any{"version": 1, "modelId": model, "resolution": resolution, "mode": mode, "unit": unit, "unitPrice": price, "durationSeconds": duration, "quotedCredits": quoted, "billingGroupId": pricing.GroupID, "digest": hex.EncodeToString(snapshotDigest[:])}
	return goVideoQuote{Mode: mode, Unit: unit, UnitPrice: price, Quoted: quoted, Snapshot: snapshot, Digest: hex.EncodeToString(digest[:]), Revision: cfg.Revision, GroupID: pricing.GroupID, SupportedRes: cfg.SupportedResolutions, MaxReference: cfg.Capability.RefMax, CustomModel: cfg.Custom}, nil
}

// chargeVideoTask atomically consumes the persisted billing snapshot before a
// provider call. It is idempotent on (user,operation_type,operation_id), so a
// worker retry cannot double charge the same task.
func (b *backend) chargeVideoTask(ctx context.Context, taskID string) error {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	var userID, stage string
	var apiKeyID *string
	var metadata []byte
	var created time.Time
	var existing float64
	if err = tx.QueryRow(ctx, `SELECT user_id,api_key_id,COALESCE(stage,'created'),COALESCE(metadata,'{}'::json),created_at,COALESCE(credits_consumed,0) FROM video_generation WHERE id=$1 FOR UPDATE`, taskID).Scan(&userID, &apiKeyID, &stage, &metadata, &created, &existing); err != nil {
		return err
	}
	if stage != "created" || existing > 0 {
		return tx.Commit(ctx)
	}
	var meta map[string]any
	if err = json.Unmarshal(metadata, &meta); err != nil {
		return err
	}
	snapshot, _ := meta["videoBillingSnapshot"].(map[string]any)
	amount, err := validateCreditAmount(imageCreditValue(snapshot["quotedCredits"], 0), false)
	if err != nil {
		return err
	}
	r := (&http.Request{}).WithContext(ctx)
	wallet, err := b.lockCreditWallet(r, tx, userID)
	if err != nil {
		return err
	}
	result, err := b.consumeCreditTx(r, tx, wallet, creditMutation{UserID: userID, Amount: amount, ServiceName: "video_generation", SourceRef: videoLedgerSourceRef(taskID, metadata), Reason: "视频生成", OperationType: "video_generation", OperationID: taskID, OperationCreatedAt: &created, Metadata: map[string]any{"videoGenerationId": taskID, "videoBillingSnapshot": snapshot}})
	if err != nil {
		return err
	}
	reserved := 0.0
	if apiKeyID != nil && strings.TrimSpace(*apiKeyID) != "" {
		if !result.Replayed {
			tag, err := tx.Exec(ctx, `UPDATE external_api_key SET credits_used=credits_used+$3,last_used_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2 AND is_active AND (credit_limit IS NULL OR credits_used+$3<=credit_limit)`, *apiKeyID, userID, amount)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return &apiError{402, "API_KEY_CREDIT_LIMIT", "API key credit limit exceeded"}
			}
		}
		reserved = amount
	}
	if _, err = tx.Exec(ctx, `UPDATE video_generation SET credits_consumed=$2,api_key_credits_reserved=$3,stage='charged',status='pending',updated_at=now() WHERE id=$1 AND stage='created'`, taskID, amount, reserved); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (b *backend) reserveGoVideoAdmission(ctx context.Context, userID, scope, taskID string) error {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "video-user:"+userID); err != nil {
		return err
	}
	var principalActive, userActive int
	if err = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM video_generation WHERE user_id=$1 AND principal_scope=$2 AND stage NOT IN ('completed','failed'))+(SELECT count(*) FROM video_task_staging_reservation WHERE user_id=$1 AND principal_scope=$2 AND expires_at>now()), (SELECT count(*) FROM video_generation WHERE user_id=$1 AND stage NOT IN ('completed','failed'))+(SELECT count(*) FROM video_task_staging_reservation WHERE user_id=$1 AND expires_at>now())`, userID, scope).Scan(&principalActive, &userActive); err != nil {
		return err
	}
	if userActive >= 10 {
		return &apiError{429, "VIDEO_CONCURRENCY_LIMIT_EXCEEDED", "视频任务已达到用户并发上限"}
	}
	if principalActive >= 5 {
		return &apiError{429, "VIDEO_CONCURRENCY_LIMIT_EXCEEDED", "视频任务已达到调用主体并发上限"}
	}
	_, err = tx.Exec(ctx, `INSERT INTO video_task_staging_reservation(task_id,reservation_token,user_id,principal_scope,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes',now(),now()) ON CONFLICT(task_id) DO NOTHING`, taskID, newRequestID(), userID, scope)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func collectVideoStorageRefs(value any) []videoStorageRef {
	seen := map[string]bool{}
	refs := make([]videoStorageRef, 0)
	var visit func(any)
	visit = func(node any) {
		switch item := node.(type) {
		case map[string]any:
			if source, _ := item["source"].(string); source == "storage" {
				key, _ := item["storageKey"].(string)
				bucket, _ := item["storageBucket"].(string)
				if key != "" {
					if bucket == "" {
						bucket = "generations"
					}
					id := bucket + "\x00" + key
					if !seen[id] {
						seen[id] = true
						refs = append(refs, videoStorageRef{key: key, bucket: bucket})
					}
				}
			}
			for _, child := range item {
				visit(child)
			}
		case []any:
			for _, child := range item {
				visit(child)
			}
		}
	}
	visit(value)
	return refs
}
