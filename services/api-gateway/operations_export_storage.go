package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

// Load provider coordinates in one statement so a download/upload never mixes
// settings from separate revisions. Configuration changes also hold the export
// storage advisory lock and cannot pass while durable export objects exist.
type operationsExportStorage struct {
	bucket, root string
	client       *s3.Client
}

func (b *backend) operationsExportStorage(ctx context.Context) (operationsExportStorage, error) {
	var st operationsExportStorage
	var endpoint, access, secret, region string
	err := b.db.QueryRow(ctx, `SELECT COALESCE((SELECT value#>>'{}' FROM system_setting WHERE key='STORAGE_BUCKET_NAME'),$1),COALESCE((SELECT value#>>'{}' FROM system_setting WHERE key='STORAGE_ENDPOINT'),$2),COALESCE((SELECT value#>>'{}' FROM system_setting WHERE key='STORAGE_ACCESS_KEY_ID'),$3),COALESCE((SELECT value#>>'{}' FROM system_setting WHERE key='STORAGE_SECRET_ACCESS_KEY'),$4),COALESCE((SELECT value#>>'{}' FROM system_setting WHERE key='STORAGE_REGION'),$5),COALESCE(NULLIF((SELECT value#>>'{}' FROM system_setting WHERE key='LOCAL_STORAGE_PATH'),''),$6)`, getString(os.LookupEnv, "STORAGE_BUCKET_NAME", "gpt2image-uploads"), getString(os.LookupEnv, "STORAGE_ENDPOINT", ""), getString(os.LookupEnv, "STORAGE_ACCESS_KEY_ID", ""), getString(os.LookupEnv, "STORAGE_SECRET_ACCESS_KEY", ""), getString(os.LookupEnv, "STORAGE_REGION", "auto"), b.config.storagePath).Scan(&st.bucket, &endpoint, &access, &secret, &region, &st.root)
	if err != nil {
		return st, err
	}
	if !validStorageObjectPath(st.bucket, "operations-exports/check.csv") {
		return st, invalid("导出存储配置无效")
	}
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return st, nil
	}
	if access == "" || secret == "" {
		return st, &apiError{503, "STORAGE_UNAVAILABLE", "导出存储凭据尚未配置"}
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(access, secret, "")))
	if err != nil {
		return st, err
	}
	st.client = s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true; o.BaseEndpoint = aws.String(endpoint) })
	return st, nil
}

func (st operationsExportStorage) put(ctx context.Context, key string, source *os.File, size int64) error {
	if !validStorageObjectPath(st.bucket, key) {
		return invalid("导出存储路径无效")
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if st.client != nil {
		_, err := st.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(st.bucket), Key: aws.String(key), Body: source, ContentLength: aws.Int64(size), ContentType: aws.String("text/csv; charset=utf-8")})
		return err
	}
	dest := filepath.Join(st.root, st.bucket, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(dest), 0750); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(dest), filepath.Base(key)+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = f.Chmod(0640); err != nil {
		return err
	}
	if _, err = io.Copy(f, &operationsExportContextReader{ctx: ctx, source: source}); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return os.Rename(f.Name(), dest)
}

type operationsExportContextReader struct {
	ctx    context.Context
	source io.Reader
}

func (r *operationsExportContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.source.Read(p)
}
func (st operationsExportStorage) delete(ctx context.Context, bucket, key string) error {
	if !validStorageObjectPath(bucket, key) || !strings.HasPrefix(key, "operations-exports/") {
		return invalid("导出存储路径无效")
	}
	if st.client != nil {
		_, err := st.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
		return err
	}
	err := os.Remove(filepath.Join(st.root, bucket, filepath.FromSlash(key)))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

type operationsDownloadableExport struct {
	id, owner, kind, bucket, key string
	expires, now                 time.Time
}

func (b *backend) ownedDownloadableExport(ctx context.Context, id, owner string) (operationsDownloadableExport, error) {
	var t operationsDownloadableExport
	t.id = id
	t.owner = owner
	err := b.db.QueryRow(ctx, `SELECT export_type,object_bucket,object_key,expires_at,clock_timestamp() FROM operations_export_task WHERE id=$1 AND created_by=$2 AND status='completed' AND object_bucket<>'' AND object_key<>'' AND expires_at>clock_timestamp()+interval '1 second'`, id, owner).Scan(&t.kind, &t.bucket, &t.key, &t.expires, &t.now)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, &apiError{404, "NOT_FOUND", "导出任务不存在、已过期或尚不可下载"}
	}
	if err != nil {
		return t, err
	}
	if !operationsExportTypeValid(t.kind) || !validStorageObjectPath(t.bucket, t.key) || !strings.HasPrefix(t.key, "operations-exports/"+id+"/") {
		return t, &apiError{409, "CONFLICT", "导出不可用"}
	}
	return t, nil
}
func operationsExportFilename(kind, id string) string {
	safe := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(id, "_")
	return "operations-" + kind + "-" + safe + ".csv"
}
func (b *backend) handleOperationsPrepareDownload(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	var in struct {
		TaskID string `json:"taskId"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	in.TaskID = strings.TrimSpace(in.TaskID)
	if !operationsExportIDValid(in.TaskID) {
		return invalid("taskId is required")
	}
	t, err := b.ownedDownloadableExport(r.Context(), in.TaskID, s.User.ID)
	if err != nil {
		return err
	}
	st, err := b.operationsExportStorage(r.Context())
	if err != nil {
		return err
	}
	ttl := int(t.expires.Sub(t.now) / time.Second)
	if ttl > 60 {
		ttl = 60
	}
	if ttl < 1 {
		return &apiError{409, "CONFLICT", "导出已过期"}
	}
	mode := "stream"
	publicBase := b.config.publicAppURL
	if publicBase == "" {
		publicBase = b.config.authURL
	}
	downloadURL := strings.TrimRight(publicBase, "/") + "/api/admin/operations/exports/" + urlPathEscape(t.id) + "/download"
	if st.client != nil {
		mode = "redirect"
		url, e := s3.NewPresignClient(st.client).PresignGetObject(r.Context(), &s3.GetObjectInput{Bucket: aws.String(t.bucket), Key: aws.String(t.key), ResponseContentType: aws.String("text/csv; charset=utf-8"), ResponseContentDisposition: aws.String(`attachment; filename="` + operationsExportFilename(t.kind, t.id) + `"`)}, func(o *s3.PresignOptions) { o.Expires = time.Duration(ttl) * time.Second })
		if e != nil {
			return e
		}
		downloadURL = url.URL
	}
	if err = operationsExportAudit(r.Context(), b.db, s.User.ID, "operations.downloadExport", t.id, map[string]any{"mode": mode, "result": "granted"}); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"taskId": t.id, "mode": mode, "downloadUrl": downloadURL, "expiresAt": t.now.Add(time.Duration(ttl) * time.Second)})
	return nil
}
func (b *backend) downloadOperationsExport(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	id := strings.TrimSpace(r.PathValue("taskId"))
	if !operationsExportIDValid(id) {
		return invalid("taskId is required")
	}
	t, err := b.ownedDownloadableExport(r.Context(), id, s.User.ID)
	if err != nil {
		return err
	}
	st, err := b.operationsExportStorage(r.Context())
	if err != nil {
		return err
	}
	if st.client != nil {
		return &apiError{409, "CONFLICT", "请重新获取远程导出下载链接"}
	}
	f, err := os.Open(filepath.Join(st.root, t.bucket, filepath.FromSlash(t.key)))
	if os.IsNotExist(err) {
		return &apiError{404, "NOT_FOUND", "导出文件不存在"}
	}
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return &apiError{404, "NOT_FOUND", "导出文件不存在"}
	}
	if err = operationsExportAudit(r.Context(), b.db, s.User.ID, "operations.downloadExport", id, map[string]any{"mode": "stream", "result": "started"}); err != nil {
		return err
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+operationsExportFilename(t.kind, id)+`"`)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, operationsExportFilename(t.kind, id), info.ModTime(), f)
	return nil
}
