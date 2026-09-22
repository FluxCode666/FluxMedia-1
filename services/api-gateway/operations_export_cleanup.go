package main

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Opaque provider cursors advance only after an entirely successful page.
// A restart re-scans from the prefix; reference/lease checks make that safe.
type operationsExportScan struct {
	mu                               sync.Mutex
	objects, keyMarker, uploadMarker string
}

var operationsExportScans sync.Map

type operationsExportStoredObject struct {
	key      string
	modified time.Time
}

func parseOperationsExportObjectKey(key string) (task, token string, ok bool) {
	parts := strings.Split(key, "/")
	if len(parts) != 3 || parts[0] != "operations-exports" || parts[1] == "" {
		return
	}
	marker := strings.Index(parts[2], ".csv")
	if marker <= 0 {
		return
	}
	suffix := parts[2][marker+4:]
	if suffix != "" && (!strings.HasPrefix(suffix, ".") || !strings.HasSuffix(suffix, ".tmp")) {
		return
	}
	return parts[1], parts[2][:marker], true
}
func (storage operationsExportStorage) list(ctx context.Context, cursor string, limit int) ([]operationsExportStoredObject, string, error) {
	out := []operationsExportStoredObject{}
	if storage.client != nil {
		input := &s3.ListObjectsV2Input{Bucket: aws.String(storage.bucket), Prefix: aws.String("operations-exports/"), MaxKeys: aws.Int32(int32(limit))}
		if cursor != "" {
			input.ContinuationToken = aws.String(cursor)
		}
		page, err := storage.client.ListObjectsV2(ctx, input)
		if err != nil {
			return nil, "", err
		}
		for _, o := range page.Contents {
			if o.Key != nil && o.LastModified != nil {
				out = append(out, operationsExportStoredObject{*o.Key, *o.LastModified})
			}
		}
		return out, aws.ToString(page.NextContinuationToken), nil
	}
	root := filepath.Join(storage.root, storage.bucket)
	more := false
	stop := errors.New("export page filled")
	err := filepath.WalkDir(filepath.Join(root, "operations-exports"), func(path string, entry fs.DirEntry, walkErr error) error {
		if os.IsNotExist(walkErr) {
			return nil
		}
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if key <= cursor {
			return nil
		}
		if len(out) == limit {
			more = true
			return stop
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		out = append(out, operationsExportStoredObject{key, info.ModTime()})
		return nil
	})
	if errors.Is(err, stop) {
		err = nil
	}
	next := ""
	if more {
		next = out[len(out)-1].key
	}
	return out, next, err
}
func (b *backend) discoverOperationsExportOrphans(ctx context.Context, storage operationsExportStorage, limit int) error {
	value, _ := operationsExportScans.LoadOrStore(b, &operationsExportScan{})
	scan := value.(*operationsExportScan)
	scan.mu.Lock()
	defer scan.mu.Unlock()
	page, next, err := storage.list(ctx, scan.objects, limit)
	if err != nil {
		return err
	}
	cutoff := time.Now().Add(-2 * time.Minute)
	failed := false
	for _, o := range page {
		if !o.modified.Before(cutoff) {
			continue
		}
		task, token, ok := parseOperationsExportObjectKey(o.key)
		if !ok {
			continue
		}
		protected, e := b.operationsExportObjectProtected(ctx, task, token, storage.bucket, o.key)
		if e != nil {
			return e
		}
		if protected {
			continue
		}
		if e = storage.delete(ctx, storage.bucket, o.key); e != nil {
			failed = true
			if e = b.recordOperationsExportOrphan(ctx, operationsExportClaim{ID: task, Token: token}, storage.bucket, o.key, "orphan_object_delete_failed"); e != nil {
				return e
			}
		}
	}
	if !failed {
		scan.objects = next
	}
	// Old Node deployments used multipart streaming. Go writes a seekable file
	// with PutObject, but still retires abandoned multipart uploads from before
	// migration, while excluding all currently claimed task/token pairs.
	if storage.client == nil {
		return nil
	}
	input := &s3.ListMultipartUploadsInput{Bucket: aws.String(storage.bucket), Prefix: aws.String("operations-exports/"), MaxUploads: aws.Int32(int32(limit))}
	if scan.keyMarker != "" {
		input.KeyMarker = aws.String(scan.keyMarker)
	}
	if scan.uploadMarker != "" {
		input.UploadIdMarker = aws.String(scan.uploadMarker)
	}
	uploads, err := storage.client.ListMultipartUploads(ctx, input)
	if err != nil {
		return err
	}
	failed = false
	for _, u := range uploads.Uploads {
		if u.Key == nil || u.UploadId == nil || u.Initiated == nil || !u.Initiated.Before(cutoff) {
			continue
		}
		task, token, ok := parseOperationsExportObjectKey(*u.Key)
		if !ok {
			continue
		}
		protected, e := b.operationsExportObjectProtected(ctx, task, token, storage.bucket, *u.Key)
		if e != nil {
			return e
		}
		if protected {
			continue
		}
		_, e = storage.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: aws.String(storage.bucket), Key: u.Key, UploadId: u.UploadId})
		if e != nil {
			failed = true
		}
	}
	if !failed {
		scan.keyMarker = aws.ToString(uploads.NextKeyMarker)
		scan.uploadMarker = aws.ToString(uploads.NextUploadIdMarker)
	}
	return nil
}
