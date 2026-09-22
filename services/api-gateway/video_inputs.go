package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type namedVideoReference struct {
	field     string
	index     int
	reference map[string]any
}

func namedVideoReferences(manifest map[string]any) ([]namedVideoReference, error) {
	out := []namedVideoReference{}
	for _, field := range []string{"firstFrame", "lastFrame", "referenceImages", "referenceVideos", "referenceAudios"} {
		value, exists := manifest[field]
		if !exists {
			continue
		}
		if field == "firstFrame" || field == "lastFrame" {
			ref, ok := value.(map[string]any)
			if !ok {
				return nil, invalid("Invalid video frame reference")
			}
			out = append(out, namedVideoReference{field, 0, ref})
			continue
		}
		var items []map[string]any
		switch list := value.(type) {
		case []map[string]any:
			items = list
		case []any:
			for _, raw := range list {
				ref, ok := raw.(map[string]any)
				if !ok {
					return nil, invalid("Invalid video media reference")
				}
				items = append(items, ref)
			}
		default:
			return nil, invalid("Invalid video references")
		}
		for i, ref := range items {
			out = append(out, namedVideoReference{field, i, ref})
		}
	}
	if len(out) > 256 {
		return nil, invalid("Too many video inputs")
	}
	return out, nil
}

func appendVideoReference(manifest map[string]any, entry namedVideoReference, ref map[string]any) {
	if entry.field == "firstFrame" || entry.field == "lastFrame" {
		manifest[entry.field] = ref
		return
	}
	items, _ := manifest[entry.field].([]any)
	manifest[entry.field] = append(items, ref)
}

func (b *backend) stageNativeVideoInputs(ctx context.Context, userID, videoID string, source map[string]any) (map[string]any, error) {
	named, err := namedVideoReferences(source)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if len(named) == 0 {
		return out, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	var attempt string
	if err = b.db.QueryRow(ctx, `SELECT reservation_token FROM video_task_staging_reservation WHERE task_id=$1 AND user_id=$2 AND expires_at>now()`, videoID, userID).Scan(&attempt); err != nil {
		return nil, err
	}
	_, bucket, err := b.storageBuckets(ctx)
	if err != nil {
		return nil, err
	}
	loaded := make([][]byte, len(named))
	total := 0
	videoDuration := 0.0
	for i, entry := range named {
		ref := entry.reference
		mime := mapString(ref, "mimeType")
		max := 200 << 20
		if entry.field == "referenceAudios" {
			max = 15 << 20
		}
		allowed := false
		switch entry.field {
		case "referenceVideos":
			allowed = mime == "video/mp4" || mime == "video/quicktime"
		case "referenceAudios":
			allowed = mime == "audio/mpeg" || mime == "audio/wav" || mime == "audio/x-wav"
		default:
			allowed = mime == "image/png" || mime == "image/jpeg" || mime == "image/webp"
		}
		if !allowed {
			return nil, invalid("Invalid video input MIME")
		}
		var data []byte
		switch mapString(ref, "source") {
		case "data":
			encoded := mapString(ref, "base64")
			if len(encoded) > base64.StdEncoding.EncodedLen(max) {
				return nil, invalid("Video input is too large")
			}
			data, err = base64.StdEncoding.Strict().DecodeString(encoded)
		case "storage":
			key, bk := mapString(ref, "storageKey"), mapString(ref, "storageBucket")
			if bk == "" {
				bk = bucket
			}
			if err = b.validateModerationStorageOwner(ctx, userID, bk, key); err != nil {
				return nil, err
			}
			data, err = b.readStorageObjectLimited(ctx, bk, key, int64(max))
		case "remote":
			data, err = readVideoRemoteInput(ctx, mapString(ref, "url"), max)
		default:
			return nil, invalid("Invalid video input source")
		}
		if err != nil {
			return nil, invalid("Video input could not be loaded")
		}
		if len(data) == 0 || len(data) > max {
			return nil, invalid("Video input exceeds the file size limit")
		}
		if declared, ok := ref["byteLength"]; ok && imageCreditValue(declared, -1) != float64(len(data)) {
			return nil, invalid("Video input byte length does not match its contents")
		}
		actual := detectVideoInputMIME(data)
		if actual != mime && !(strings.HasPrefix(actual, "video/") && strings.HasPrefix(mime, "video/")) && !(actual == "audio/wav" && mime == "audio/x-wav") {
			return nil, invalid("Video input MIME does not match its contents")
		}
		total += len(data)
		if total > 512<<20 {
			return nil, invalid("Video inputs exceed the total upload limit")
		}
		if entry.field == "referenceVideos" || entry.field == "referenceAudios" {
			duration, err := probeVideoInput(ctx, data, entry.field == "referenceVideos")
			if err != nil {
				return nil, err
			}
			if entry.field == "referenceVideos" {
				videoDuration += duration
			}
		}
		loaded[i] = data
	}
	if videoDuration > 15 {
		return nil, invalid("Reference videos must total at most 15 seconds")
	}
	for i, entry := range named {
		mime := mapString(entry.reference, "mimeType")
		extension := map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav"}[mime]
		digest := sha256.Sum256(loaded[i])
		key := fmt.Sprintf("%s/video-inputs/%s/%s/%s-%d-%s.%s", userID, videoID, attempt, entry.field, entry.index, hex.EncodeToString(digest[:16]), extension)
		if !validStorageObjectPath(bucket, key) {
			return nil, invalid("Invalid video staging path")
		}
		// Persist orphan intent before uploading, then adopt it in the creation transaction.
		if _, err = b.db.Exec(ctx, `INSERT INTO video_input_cleanup(id,user_id,video_id,attempt_id,storage_key,storage_bucket,reason,next_attempt_at) VALUES($1,$2,$3,$4,$5,$6,'orphan',now()+interval '5 minutes')`, newRequestID(), userID, videoID, attempt, key, bucket); err != nil {
			return nil, err
		}
		if err = b.putStorageObject(ctx, bucket, key, loaded[i], mime); err != nil {
			return nil, err
		}
		appendVideoReference(out, entry, map[string]any{"source": "storage", "mimeType": mime, "storageKey": key, "storageBucket": bucket, "byteLength": len(loaded[i])})
	}
	return out, nil
}

func (b *backend) adoptNativeVideoInputs(ctx context.Context, tx pgx.Tx, userID, videoID string, manifest map[string]any) error {
	named, err := namedVideoReferences(manifest)
	if err != nil {
		return err
	}
	for _, entry := range named {
		key, bucket := mapString(entry.reference, "storageKey"), mapString(entry.reference, "storageBucket")
		if !strings.HasPrefix(key, userID+"/video-inputs/"+videoID+"/") {
			return forbidden()
		}
		result, err := tx.Exec(ctx, `DELETE FROM video_input_cleanup c USING video_task_staging_reservation r WHERE c.video_id=$1 AND c.user_id=$2 AND c.storage_key=$3 AND c.storage_bucket=$4 AND c.reason='orphan' AND c.claim_token IS NULL AND r.task_id=c.video_id AND r.user_id=c.user_id AND r.reservation_token=c.attempt_id AND r.expires_at>now()`, videoID, userID, key, bucket)
		if err != nil {
			return err
		}
		if result.RowsAffected() != 1 {
			return &apiError{409, "VIDEO_STAGING_EXPIRED", "Video input staging reservation expired"}
		}
	}
	return nil
}

func detectVideoInputMIME(data []byte) string {
	if len(data) >= 12 && string(data[4:8]) == "ftyp" {
		if string(data[8:12]) == "qt  " {
			return "video/quicktime"
		}
		return "video/mp4"
	}
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WAVE" {
		return "audio/wav"
	}
	if len(data) >= 3 && string(data[:3]) == "ID3" || len(data) >= 2 && data[0] == 0xff && data[1] >= 0xe0 && data[1] != 0xd8 {
		return "audio/mpeg"
	}
	return http.DetectContentType(data)
}

func validateVideoRemoteURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return invalid("Video media URL must use public HTTP or HTTPS")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !publicMediaIP(ip) {
		return invalid("Video media URL must be public")
	}
	return nil
}
func readVideoRemoteInput(ctx context.Context, raw string, max int) ([]byte, error) {
	if err := validateVideoRemoteURL(raw); err != nil {
		return nil, err
	}
	transport := publicMediaTransport()
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return validateVideoRemoteURL(r.URL.String())
	}}
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, errors.New("video media fetch failed")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(max)+1))
	if len(data) > max {
		return nil, errors.New("video media exceeds limit")
	}
	return data, err
}

type videoProbeResult struct {
	Streams []struct {
		Width    int    `json:"width"`
		Height   int    `json:"height"`
		Duration string `json:"duration"`
		FPS      string `json:"avg_frame_rate"`
		Rate     string `json:"r_frame_rate"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

func probeVideoInput(ctx context.Context, data []byte, video bool) (float64, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	executable := strings.TrimSpace(os.Getenv("FFPROBE_PATH"))
	if executable == "" {
		executable = "ffprobe"
	}
	stream := "a:0"
	if video {
		stream = "v:0"
	}
	command := exec.CommandContext(ctx, executable, "-v", "error", "-select_streams", stream, "-show_entries", "stream=width,height,duration,avg_frame_rate,r_frame_rate:format=duration", "-of", "json", "-i", "pipe:0")
	command.Stdin = bytes.NewReader(data)
	raw, err := command.Output()
	if err != nil {
		return 0, invalid("Reference media metadata could not be read")
	}
	var probe videoProbeResult
	if json.Unmarshal(raw, &probe) != nil || len(probe.Streams) == 0 {
		return 0, invalid("Reference media has no readable stream")
	}
	item := probe.Streams[0]
	duration, _ := strconv.ParseFloat(item.Duration, 64)
	if duration <= 0 {
		duration, _ = strconv.ParseFloat(probe.Format.Duration, 64)
	}
	if math.IsNaN(duration) || math.IsInf(duration, 0) || duration <= 0 {
		return 0, invalid("Invalid reference media duration")
	}
	if !video {
		if duration > 15 {
			return 0, invalid("Reference audio must be at most 15 seconds")
		}
		return duration, nil
	}
	rate := func(text string) float64 {
		parts := strings.Split(text, "/")
		a, _ := strconv.ParseFloat(parts[0], 64)
		if len(parts) == 2 {
			d, _ := strconv.ParseFloat(parts[1], 64)
			if d <= 0 {
				return 0
			}
			a /= d
		}
		return a
	}
	fps := rate(item.FPS)
	if fps <= 0 {
		fps = rate(item.Rate)
	}
	if duration < 4 || duration > 10 || item.Width < 720 || item.Height < 720 || item.Width > 2160 || item.Height > 2160 || math.IsNaN(fps) || math.IsInf(fps, 0) || fps < 24 || fps > 60 {
		return 0, invalid("Reference video must be 4-10 seconds, 720-2160 pixels and 24-60 FPS")
	}
	return duration, nil
}

func (b *backend) videoInputAssets(r *http.Request, userID, taskID string, manifest map[string]any) (map[string]any, error) {
	named, err := namedVideoReferences(manifest)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"taskId": taskID, "summary": videoInputSummary(manifest)}
	_, bucket, err := b.storageBuckets(r.Context())
	if err != nil {
		return nil, err
	}
	for _, entry := range named {
		key, bk := mapString(entry.reference, "storageKey"), mapString(entry.reference, "storageBucket")
		if mapString(entry.reference, "source") != "storage" || bk != bucket || !validStorageObjectPath(bk, key) || !strings.HasPrefix(key, userID+"/video-inputs/"+taskID+"/") {
			return nil, errors.New("video input manifest contains an untrusted object")
		}
		url, err := b.storageSignedReadURL(r.Context(), bk, key, 900)
		if err != nil {
			return nil, err
		}
		if strings.HasPrefix(url, "/") {
			url = b.absoluteVideoURL(r, url)
		}
		appendVideoReference(out, entry, map[string]any{"url": url, "mimeType": entry.reference["mimeType"]})
	}
	return out, nil
}
