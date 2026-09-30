package main

// 火山方舟 Seedance 兼容入站视频网关：/api/v3/contents/generations/tasks。
//
// 外部客户端使用 FluxMedia API Key 按方舟协议创建和查询视频任务。约束如下：
//   - 请求严格归一为平台原生视频输入，复用原生管线的幂等、计费、媒体暂存与调度；
//   - 平台无法如实兑现的方舟参数（水印、种子、样片、离线推理等）只接受默认值，
//     其他取值一律拒绝，避免计费参数与实际生成参数不一致；
//   - 方舟任务 ID 即平台视频任务 ID，查询只返回经本网关创建的任务；
//   - 不提供任务列表与取消接口。

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// seedanceArkModels 把方舟 Seedance 2.0 模型 ID 映射为平台模型 ID；未列出的名称按平台模型 ID 原样使用。
var seedanceArkModels = map[string]string{
	"doubao-seedance-2-0-260128":        "seedance2",
	"dreamina-seedance-2-0-260128":      "seedance2",
	"doubao-seedance-2-0-fast-260128":   "seedance2-fast",
	"dreamina-seedance-2-0-fast-260128": "seedance2-fast",
}

// seedancePromptFlag 匹配文本提示词末尾的一个弱校验参数（--name value）。
var seedancePromptFlag = regexp.MustCompile(`(?:^|\s+)--([a-z]+)\s+(\S+)\s*$`)

// seedanceKnownFlag 匹配任意位置的已知弱校验参数。方舟会从提示词中解析这些参数并覆盖请求体取值，
// 残留在提示词中会导致实际生成参数与计费参数不一致。
var seedanceKnownFlag = regexp.MustCompile(`(?:^|\s)--(?:rs|resolution|rt|ratio|dur|duration|frames|seed|cf|camerafixed|wm|watermark)(?:\s|$)`)

// seedancePlatformModel 判断平台模型是否由方舟 Seedance 提供。
func seedancePlatformModel(model string) bool {
	for _, platform := range seedanceArkModels {
		if platform == model {
			return true
		}
	}
	return false
}

// seedancePromptFlagNames 把弱校验参数的缩写与全称映射为请求体字段名。
var seedancePromptFlagNames = map[string]string{
	"rs": "resolution", "resolution": "resolution", "rt": "ratio", "ratio": "ratio",
	"dur": "duration", "duration": "duration", "frames": "frames", "seed": "seed",
	"cf": "camera_fixed", "camerafixed": "camera_fixed", "wm": "watermark", "watermark": "watermark",
}

// seedanceDataMIME 是 data URL 可接受的 MIME 及其规范值，按媒体类型区分。
var seedanceDataMIME = map[string]map[string]string{
	"image": {"image/png": "image/png", "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/webp": "image/webp"},
	"video": {"video/mp4": "video/mp4", "video/quicktime": "video/quicktime"},
	"audio": {"audio/mpeg": "audio/mpeg", "audio/mp3": "audio/mpeg", "audio/wav": "audio/wav", "audio/x-wav": "audio/x-wav"},
}

// seedanceExtensionMIME 按远程地址路径扩展名推断 MIME；暂存时仍会按实际内容校验。
var seedanceExtensionMIME = map[string]map[string]string{
	"image": {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"},
	"video": {".mp4": "video/mp4", ".mov": "video/quicktime"},
	"audio": {".mp3": "audio/mpeg", ".wav": "audio/wav"},
}

type seedanceMediaURL struct {
	URL string `json:"url"`
}

type seedanceContentItem struct {
	Type      string            `json:"type"`
	Text      *string           `json:"text"`
	ImageURL  *seedanceMediaURL `json:"image_url"`
	VideoURL  *seedanceMediaURL `json:"video_url"`
	AudioURL  *seedanceMediaURL `json:"audio_url"`
	Role      *string           `json:"role"`
	DraftTask json.RawMessage   `json:"draft_task"`
}

type seedanceCreateRequest struct {
	Model                 string                `json:"model"`
	Content               []seedanceContentItem `json:"content"`
	Resolution            *string               `json:"resolution"`
	Ratio                 *string               `json:"ratio"`
	Duration              *int                  `json:"duration"`
	GenerateAudio         *bool                 `json:"generate_audio"`
	CallbackURL           *string               `json:"callback_url"`
	Watermark             *bool                 `json:"watermark"`
	Seed                  *int64                `json:"seed"`
	CameraFixed           *bool                 `json:"camera_fixed"`
	ReturnLastFrame       *bool                 `json:"return_last_frame"`
	Draft                 *bool                 `json:"draft"`
	ServiceTier           *string               `json:"service_tier"`
	OutputFormat          *string               `json:"output_format"`
	OmniReferenceTaskType *string               `json:"omni_reference_task_type"`
	Priority              *int                  `json:"priority"`
	SafetyIdentifier      *string               `json:"safety_identifier"`
	Frames                json.RawMessage       `json:"frames"`
	ExecutionExpiresAfter json.RawMessage       `json:"execution_expires_after"`
	Tools                 json.RawMessage       `json:"tools"`
}

type seedanceImage struct {
	role string
	ref  map[string]any
}

// seedanceInvalid 返回带方舟错误码的 400 错误。
func seedanceInvalid(code, message string) error {
	return &apiError{http.StatusBadRequest, code, message}
}

func seedanceUnsupported(name string) error {
	return seedanceInvalid("InvalidParameter.UnsupportedParameter", "Parameter "+name+" is not supported; omit it or use its default value")
}

func seedancePresent(raw json.RawMessage) bool {
	return len(raw) > 0 && !bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// fieldsMatch 校验内容项只携带与 type 对应的字段，role 只允许出现在媒体项上。
func (item seedanceContentItem) fieldsMatch() bool {
	present := map[string]bool{"text": item.Text != nil, "image_url": item.ImageURL != nil, "video_url": item.VideoURL != nil, "audio_url": item.AudioURL != nil, "draft_task": seedancePresent(item.DraftTask)}
	for kind, exists := range present {
		if exists != (kind == item.Type) {
			return false
		}
	}
	return item.Role == nil || item.Type == "image_url" || item.Type == "video_url" || item.Type == "audio_url"
}

// parseSeedanceNativeVideoRequest 把方舟创建任务请求严格转换为平台原生视频输入。
func parseSeedanceNativeVideoRequest(r *http.Request, body map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	cleaned := make(map[string]json.RawMessage, len(body))
	for key, value := range body {
		if seedancePresent(value) {
			cleaned[key] = value
		}
	}
	var request seedanceCreateRequest
	decoder := json.NewDecoder(bytes.NewReader([]byte(mustJSON(cleaned))))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		if strings.HasPrefix(err.Error(), "json: unknown field") {
			return nil, seedanceInvalid("InvalidParameter.UnsupportedParameter", "Unsupported Seedance request field: "+strings.TrimPrefix(err.Error(), "json: unknown field "))
		}
		return nil, seedanceInvalid("InvalidParameter", "Invalid Seedance request: "+err.Error())
	}
	model := strings.TrimSpace(request.Model)
	if model == "" {
		return nil, seedanceInvalid("MissingParameter", "model is required")
	}
	if !videoSafeLabel.MatchString(model) || len(model) > 120 {
		return nil, seedanceInvalid("InvalidParameter", "Invalid model")
	}
	platformModel := seedanceArkModels[model]
	if platformModel == "" {
		platformModel = model
	}
	if len(request.Content) == 0 {
		return nil, seedanceInvalid("MissingParameter", "content is required")
	}
	if len(request.Content) > 64 {
		return nil, seedanceInvalid("InvalidParameter", "content has too many items")
	}
	var text *string
	var images []seedanceImage
	var videos, audios []map[string]any
	for _, item := range request.Content {
		if !item.fieldsMatch() {
			return nil, seedanceInvalid("InvalidParameter", "content item fields do not match type "+strconv.Quote(item.Type))
		}
		role := ""
		if item.Role != nil {
			role = *item.Role
		}
		switch item.Type {
		case "text":
			if text != nil {
				return nil, seedanceInvalid("InvalidParameter", "content must contain at most one text item")
			}
			text = item.Text
		case "image_url":
			if role != "" && role != "first_frame" && role != "last_frame" && role != "reference_image" {
				return nil, seedanceInvalid("InvalidParameter", "Invalid image_url role")
			}
			ref, err := seedanceMediaReference("image", item.ImageURL.URL)
			if err != nil {
				return nil, err
			}
			images = append(images, seedanceImage{role: role, ref: ref})
		case "video_url":
			if role != "" && role != "reference_video" {
				return nil, seedanceInvalid("InvalidParameter", "video_url role must be reference_video")
			}
			ref, err := seedanceMediaReference("video", item.VideoURL.URL)
			if err != nil {
				return nil, err
			}
			videos = append(videos, ref)
		case "audio_url":
			if role != "" && role != "reference_audio" {
				return nil, seedanceInvalid("InvalidParameter", "audio_url role must be reference_audio")
			}
			ref, err := seedanceMediaReference("audio", item.AudioURL.URL)
			if err != nil {
				return nil, err
			}
			audios = append(audios, ref)
		case "draft_task":
			return nil, seedanceInvalid("InvalidParameter.UnsupportedParameter", "draft_task content is not supported")
		default:
			return nil, seedanceInvalid("InvalidParameter", "Unsupported content type "+strconv.Quote(item.Type))
		}
	}
	if text == nil {
		return nil, seedanceInvalid("MissingParameter", "content must include a text prompt")
	}
	prompt, flags, err := extractSeedancePromptFlags(*text)
	if err != nil {
		return nil, err
	}
	if prompt == "" {
		return nil, seedanceInvalid("MissingParameter", "text prompt is required")
	}
	if err := applySeedancePromptFlags(&request, flags); err != nil {
		return nil, err
	}
	var firstFrame, lastFrame map[string]any
	var referenceImages []map[string]any
	roleless := 0
	for _, image := range images {
		switch image.role {
		case "first_frame":
			if firstFrame != nil {
				return nil, seedanceInvalid("InvalidParameter", "content must contain at most one first_frame")
			}
			firstFrame = image.ref
		case "last_frame":
			if lastFrame != nil {
				return nil, seedanceInvalid("InvalidParameter", "content must contain at most one last_frame")
			}
			lastFrame = image.ref
		case "reference_image":
			referenceImages = append(referenceImages, image.ref)
		default:
			roleless++
		}
	}
	if roleless > 0 {
		// 方舟允许单张无 role 图片作为首帧；多媒体输入时必须显式声明 role。
		if len(images) != 1 || len(videos) > 0 || len(audios) > 0 {
			return nil, seedanceInvalid("MissingParameter", "image_url role is required when multiple media items are provided")
		}
		firstFrame = images[0].ref
	}
	if lastFrame != nil && firstFrame == nil {
		return nil, seedanceInvalid("MissingParameter", "last_frame requires first_frame")
	}
	if firstFrame != nil && (len(referenceImages) > 0 || len(videos) > 0 || len(audios) > 0) {
		return nil, seedanceInvalid("InvalidParameter", "first_frame and last_frame cannot be combined with reference media")
	}
	if len(audios) > 0 && len(referenceImages) == 0 && len(videos) == 0 {
		return nil, seedanceInvalid("InvalidParameter", "reference_audio requires at least one reference image or video")
	}
	unsupported := []struct {
		name string
		ok   bool
	}{
		{"frames", !seedancePresent(request.Frames)},
		{"watermark", request.Watermark == nil || !*request.Watermark},
		{"seed", request.Seed == nil || *request.Seed == -1},
		{"camera_fixed", request.CameraFixed == nil || !*request.CameraFixed},
		{"return_last_frame", request.ReturnLastFrame == nil || !*request.ReturnLastFrame},
		{"draft", request.Draft == nil || !*request.Draft},
		{"service_tier", request.ServiceTier == nil || *request.ServiceTier == "default"},
		{"output_format", request.OutputFormat == nil || *request.OutputFormat == "mp4"},
		{"omni_reference_task_type", request.OmniReferenceTaskType == nil || *request.OmniReferenceTaskType == "auto"},
		{"priority", request.Priority == nil || *request.Priority == 0},
		{"execution_expires_after", !seedancePresent(request.ExecutionExpiresAfter)},
		{"tools", !seedancePresent(request.Tools)},
	}
	for _, check := range unsupported {
		if !check.ok {
			return nil, seedanceUnsupported(check.name)
		}
	}
	if request.SafetyIdentifier != nil && len(*request.SafetyIdentifier) > 64 {
		return nil, seedanceInvalid("InvalidParameter", "safety_identifier must be at most 64 characters")
	}
	resolution := "720p"
	if request.Resolution != nil {
		resolution = strings.TrimSpace(*request.Resolution)
	}
	// 平台按固定宽高比计费和生成，adaptive 无法在提交时确定输出尺寸。
	ratio := "16:9"
	if request.Ratio != nil {
		ratio = strings.TrimSpace(*request.Ratio)
		if ratio == "adaptive" {
			return nil, seedanceInvalid("InvalidParameter.UnsupportedParameter", "ratio adaptive is not supported; specify an explicit ratio")
		}
	}
	duration := 5
	if request.Duration != nil {
		duration = *request.Duration
		if duration == -1 {
			return nil, seedanceInvalid("InvalidParameter.UnsupportedParameter", "duration -1 is not supported; specify an explicit duration")
		}
		if duration <= 0 {
			return nil, seedanceInvalid("InvalidParameter", "duration must be a positive integer")
		}
	}
	generateAudio := goVideoCapabilities[platformModel].Audio
	if request.GenerateAudio != nil {
		generateAudio = *request.GenerateAudio
	}
	idempotencyKey, err := externalVideoIdempotencyKey(r)
	if err != nil {
		return nil, err
	}
	input := map[string]any{"clientRequestId": idempotencyKey, "model": platformModel, "seedanceModel": model, "prompt": prompt, "duration": duration, "aspectRatio": ratio, "resolution": resolution, "generateAudio": generateAudio}
	if request.CallbackURL != nil && strings.TrimSpace(*request.CallbackURL) != "" {
		input["callbackUrl"] = strings.TrimSpace(*request.CallbackURL)
	}
	if firstFrame != nil {
		input["firstFrame"] = firstFrame
	}
	if lastFrame != nil {
		input["lastFrame"] = lastFrame
	}
	if len(referenceImages) > 0 {
		input["referenceImages"] = referenceImages
	}
	if len(videos) > 0 {
		input["referenceVideos"] = videos
	}
	if len(audios) > 0 {
		input["referenceAudios"] = audios
	}
	var normalized map[string]json.RawMessage
	if err := json.Unmarshal([]byte(mustJSON(input)), &normalized); err != nil {
		return nil, err
	}
	if _, err := parseNativeVideoInput(normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

// seedanceMediaReference 把方舟媒体地址转换为平台原生媒体引用：支持 Base64 data URL
// 和公网 HTTP(S) 地址；方舟素材 ID（asset://）无法在平台解析，一律拒绝。
func seedanceMediaReference(kind, raw string) (map[string]any, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return nil, seedanceInvalid("MissingParameter", kind+"_url.url is required")
	}
	if strings.HasPrefix(text, "asset://") {
		return nil, seedanceInvalid("InvalidParameter.UnsupportedParameter", "Ark asset IDs are not supported; use a data URL or public URL")
	}
	if strings.HasPrefix(text, "data:") {
		header, encoded, ok := strings.Cut(strings.TrimPrefix(text, "data:"), ";base64,")
		mime := seedanceDataMIME[kind][strings.ToLower(strings.TrimSpace(header))]
		if !ok || mime == "" {
			return nil, seedanceInvalid("InvalidParameter", "Unsupported "+kind+" data URL type")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || len(data) == 0 {
			return nil, seedanceInvalid("InvalidParameter", "Invalid base64 in "+kind+" data URL")
		}
		return map[string]any{"source": "data", "mimeType": mime, "base64": encoded, "byteLength": len(data)}, nil
	}
	if len(text) > 2048 {
		return nil, seedanceInvalid("InvalidParameter", kind+" URL is too long")
	}
	if err := validateVideoRemoteURL(text); err != nil {
		return nil, err
	}
	u, err := url.Parse(text)
	if err != nil {
		return nil, err
	}
	mime := seedanceExtensionMIME[kind][strings.ToLower(path.Ext(u.Path))]
	if mime == "" {
		return nil, seedanceInvalid("InvalidParameter", kind+" URL must end with a supported file extension; otherwise use a data URL")
	}
	return map[string]any{"source": "remote", "mimeType": mime, "url": text}, nil
}

// extractSeedancePromptFlags 从文本末尾依次剥离方舟弱校验参数，返回剩余提示词和参数。
// 同一参数重复且取值不同时拒绝；剥离后正文仍含已知参数时同样拒绝。
func extractSeedancePromptFlags(text string) (string, map[string]string, error) {
	flags := map[string]string{}
	for {
		match := seedancePromptFlag.FindStringSubmatchIndex(text)
		if match == nil {
			break
		}
		name := seedancePromptFlagNames[text[match[2]:match[3]]]
		if name == "" {
			break
		}
		value := text[match[4]:match[5]]
		if previous, exists := flags[name]; exists && previous != value {
			return "", nil, seedanceInvalid("InvalidParameter", "Conflicting prompt parameter "+name)
		}
		flags[name] = value
		text = text[:match[0]]
	}
	if seedanceKnownFlag.MatchString(text) {
		return "", nil, seedanceInvalid("InvalidParameter", "Prompt parameters must be appended at the end of the text")
	}
	return strings.TrimSpace(text), flags, nil
}

// applySeedancePromptFlags 把弱校验参数合并进请求体字段；与请求体显式取值冲突时拒绝。
func applySeedancePromptFlags(request *seedanceCreateRequest, flags map[string]string) error {
	conflict := func(name string) error {
		return seedanceInvalid("InvalidParameter", "Prompt parameter "+name+" conflicts with the request body")
	}
	parseBool := func(name, value string) (bool, error) {
		if value != "true" && value != "false" {
			return false, seedanceInvalid("InvalidParameter", "Prompt parameter "+name+" must be true or false")
		}
		return value == "true", nil
	}
	for name, value := range flags {
		switch name {
		case "resolution", "ratio":
			target := &request.Resolution
			if name == "ratio" {
				target = &request.Ratio
			}
			if *target != nil && **target != value {
				return conflict(name)
			}
			*target = &value
		case "duration":
			duration, err := strconv.Atoi(value)
			if err != nil {
				return seedanceInvalid("InvalidParameter", "Prompt parameter duration must be an integer")
			}
			if request.Duration != nil && *request.Duration != duration {
				return conflict(name)
			}
			request.Duration = &duration
		case "seed":
			seed, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return seedanceInvalid("InvalidParameter", "Prompt parameter seed must be an integer")
			}
			if request.Seed != nil && *request.Seed != seed {
				return conflict(name)
			}
			request.Seed = &seed
		case "camera_fixed", "watermark":
			flag, err := parseBool(name, value)
			if err != nil {
				return err
			}
			target := &request.CameraFixed
			if name == "watermark" {
				target = &request.Watermark
			}
			if *target != nil && **target != flag {
				return conflict(name)
			}
			*target = &flag
		case "frames":
			return seedanceUnsupported("frames")
		}
	}
	return nil
}

// seedanceEndpoint 把平台错误改写为方舟错误体 {"error":{"code","message","type"}}，保留原 HTTP 状态码。
func (b *backend) seedanceEndpoint(fn endpoint) http.HandlerFunc {
	return b.externalEndpoint(func(w http.ResponseWriter, r *http.Request) error {
		if err := fn(w, r); err != nil {
			var known *apiError
			if !errors.As(err, &known) {
				b.logger.ErrorContext(r.Context(), "Seedance task failed", "request_id", requestID(r))
				known = &apiError{http.StatusInternalServerError, "INTERNAL", "Video task failed"}
			}
			noStore(w)
			writeJSON(w, known.status, seedanceErrorBody(known))
		}
		return nil
	})
}

// seedanceErrorBody 按方舟错误码约定改写平台错误；没有对应方舟错误码的平台错误保留原码。
func seedanceErrorBody(known *apiError) map[string]any {
	code := known.code
	switch {
	case code == "MissingParameter" || strings.HasPrefix(code, "InvalidParameter"):
	case known.status == http.StatusBadRequest && code == "INVALID_REQUEST":
		code = "InvalidParameter"
	case known.status == http.StatusUnauthorized:
		code = "AuthenticationError"
	case known.status == http.StatusForbidden && code == "FORBIDDEN":
		code = "AccessDenied"
	case known.status == http.StatusNotFound:
		code = "NotFound"
	case known.status >= 500 && strings.HasPrefix(code, "INTERNAL"):
		code = "InternalServiceError"
	}
	return map[string]any{"error": map[string]any{"code": code, "message": truncateRunes(known.message, 512), "type": strings.ReplaceAll(http.StatusText(known.status), " ", "")}}
}

// seedanceTaskView 是方舟查询任务响应与回调共用的任务快照。
type seedanceTaskView struct {
	ID, Model, Status, Ratio, Resolution, VideoURL, Error string
	Duration                                              int
	GenerateAudio                                         bool
	CreatedAt, UpdatedAt                                  time.Time
}

// object 按方舟查询任务响应结构输出。平台状态 queued、in_progress、completed、failed
// 分别对应方舟 queued、running、succeeded、failed。
func (view seedanceTaskView) object() map[string]any {
	status := map[string]string{"queued": "queued", "in_progress": "running", "completed": "succeeded", "failed": "failed"}[view.Status]
	result := map[string]any{"id": view.ID, "model": view.Model, "status": status, "error": nil, "created_at": view.CreatedAt.Unix(), "updated_at": view.UpdatedAt.Unix(), "duration": view.Duration, "ratio": view.Ratio, "resolution": view.Resolution, "generate_audio": view.GenerateAudio, "service_tier": "default"}
	if status == "succeeded" && view.VideoURL != "" {
		result["content"] = map[string]any{"video_url": view.VideoURL}
	}
	if status == "failed" {
		message := strings.TrimSpace(view.Error)
		if message == "" {
			message = "Video generation failed"
		}
		result["error"] = map[string]any{"code": "VideoGenerationFailed", "message": truncateRunes(message, 512)}
	}
	return result
}

// readNativeSeedanceTask 读取经方舟网关创建的任务；其他入口创建的任务对本接口不可见。
func (b *backend) readNativeSeedanceTask(r *http.Request, userID, keyID, scope, id string) (map[string]any, error) {
	if id == "" || len(id) > 128 {
		return nil, &apiError{http.StatusNotFound, "NOT_FOUND", "Video task not found"}
	}
	var model string
	var created, updated time.Time
	err := b.db.QueryRow(r.Context(), `SELECT metadata->>'seedanceModel',created_at,GREATEST(created_at,updated_at,COALESCE(completed_at,created_at)) FROM video_generation WHERE id=$1 AND user_id=$2 AND principal_scope=$3 AND api_key_id IS NOT DISTINCT FROM NULLIF($4,'') AND metadata->>'seedanceModel' IS NOT NULL`, id, userID, scope, keyID).Scan(&model, &created, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{http.StatusNotFound, "NOT_FOUND", "Video task not found"}
	}
	if err != nil {
		return nil, err
	}
	task, err := b.readNativeVideoStatus(r, id, userID, keyID, scope)
	if err != nil {
		return nil, err
	}
	view := seedanceTaskView{ID: id, Model: model, CreatedAt: created, UpdatedAt: updated, GenerateAudio: boolValue(task["generateAudio"])}
	view.Status, _ = task["status"].(string)
	view.Ratio, _ = task["aspectRatio"].(string)
	view.Resolution, _ = task["resolution"].(string)
	view.Duration, _ = task["duration"].(int)
	view.VideoURL, _ = task["videoUrl"].(string)
	view.Error, _ = task["error"].(string)
	return view.object(), nil
}

// handleSeedanceCreate 按方舟协议创建视频任务，响应只包含任务 ID。
func (b *backend) handleSeedanceCreate(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	body, err = parseSeedanceNativeVideoRequest(r, body)
	if err != nil {
		return err
	}
	task, err := b.createVideoTask(r, p, body)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"id": task["taskId"]})
	return nil
}

// handleSeedanceStatus 按方舟协议查询视频任务。
func (b *backend) handleSeedanceStatus(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	task, err := b.readNativeSeedanceTask(r, p.UserID, p.KeyID, "external:"+p.UserID+":"+p.KeyID, r.PathValue("id"))
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, task)
	return nil
}
