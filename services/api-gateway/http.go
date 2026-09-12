package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

type apiError struct {
	status        int
	code, message string
}

func (e *apiError) Error() string  { return e.message }
func invalid(message string) error { return &apiError{400, "INVALID_REQUEST", message} }
func unauthorized() error          { return &apiError{401, "UNAUTHORIZED", "登录已失效，请重新登录"} }
func forbidden() error             { return &apiError{403, "FORBIDDEN", "没有权限执行此操作"} }

type endpoint func(http.ResponseWriter, *http.Request) error

func (b *backend) endpoint(fn endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			var known *apiError
			if !errors.As(err, &known) {
				b.logger.ErrorContext(r.Context(), "backend operation failed", "request_id", requestID(r))
				known = &apiError{500, "INTERNAL_SERVER_ERROR", "服务器错误，请稍后重试"}
			}
			if r.URL.Path == "/api/auth/registration-verification" {
				writeJSON(w, known.status, map[string]string{"error": known.message})
			} else if strings.HasPrefix(r.URL.Path, "/api/auth/") {
				writeJSON(w, known.status, map[string]string{"code": known.code, "message": known.message})
			} else if strings.HasPrefix(r.URL.Path, "/api/v1/") || strings.HasPrefix(r.URL.Path, "/v1/") {
				writeJSON(w, known.status, map[string]any{"error": map[string]string{"message": known.message, "type": "invalid_request_error", "code": known.code}})
			} else {
				writeJSONError(w, known.status, known.code, known.message)
			}
		}
	}
}
func decodeBody(r *http.Request, target any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return &apiError{413, "REQUEST_BODY_TOO_LARGE", "请求体过大"}
		}
		return invalid("请求 JSON 无效")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return invalid("请求只能包含一个 JSON 对象")
	}
	return nil
}
func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store, no-cache, max-age=0, must-revalidate")
	w.Header().Set("CDN-Cache-Control", "no-store")
	w.Header().Set("Cloudflare-CDN-Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.Header().Set("Vary", "Cookie")
}
