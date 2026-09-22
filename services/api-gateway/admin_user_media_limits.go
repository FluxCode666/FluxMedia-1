package main

import "net/http"

func (b *backend) adminUserMediaLimits(r *http.Request, id string) (map[string]any, error) {
	defaultConcurrency, err := b.settingInt(r, "IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY", 20, 1, 10000)
	if err != nil {
		return nil, err
	}
	maxFile, err := b.settingInt(r, "MEDIA_MAX_FILE_SIZE_MB", 5, 1, 200)
	if err != nil {
		return nil, err
	}
	maxUpload, err := b.settingInt(r, "MEDIA_MAX_UPLOAD_SIZE_MB", 75, 1, 512)
	if err != nil {
		return nil, err
	}
	maxRefs, err := b.settingInt(r, "IMAGE_EDIT_MAX_REFERENCE_IMAGES", 16, 1, 256)
	if err != nil {
		return nil, err
	}
	var override *int
	if err := b.db.QueryRow(r.Context(), `SELECT image_generation_concurrency_override FROM "user" WHERE id=$1`, id).Scan(&override); err != nil {
		return nil, err
	}
	limit, source := defaultConcurrency, "system_default"
	if override != nil && *override >= 1 && *override <= 10000 {
		limit, source = *override, "user_override"
	} else {
		override = nil
	}
	return map[string]any{"defaultUserConcurrency": defaultConcurrency, "maxFileSizeMb": maxFile, "maxUploadSizeMb": maxUpload, "maxEditReferenceImages": maxRefs, "maxFileSizeBytes": maxFile * 1024 * 1024, "maxUploadSizeBytes": maxUpload * 1024 * 1024, "limit": limit, "override": override, "effectiveSource": source, "scope": "user"}, nil
}
