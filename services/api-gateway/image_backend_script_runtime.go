package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

var apiUpstreamOperations = map[string]bool{
	"images.generate": true, "images.generate.query": true, "images.edit": true,
	"images.edit.query": true, "videos.generate": true, "videos.query": true,
}

// registerImageBackendScriptRuntimeRoutes exposes the administrator-only script
// adapter test and the runtime health snapshot. Script execution remains behind
// the dedicated runtime process and never executes JavaScript in this process.
func (b *backend) registerImageBackendScriptRuntimeRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/admin/image-backend/script-runtime/test", b.endpoint(b.handleApiUpstreamScriptTest))
	mux.HandleFunc("GET /api/admin/image-backend/script-runtime/diagnostics", b.endpoint(b.handleApiUpstreamScriptDiagnostics))
}

type apiUpstreamScriptTestRequest struct {
	Operation string          `json:"operation"`
	Stage     string          `json:"stage"`
	Script    string          `json:"script"`
	Sample    json.RawMessage `json:"sample"`
}

func (b *backend) handleApiUpstreamScriptTest(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	var in apiUpstreamScriptTestRequest
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	preview, err := b.runApiUpstreamScriptTest(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"preview": preview})
	return nil
}

// runApiUpstreamScriptTest 用合成样例在隔离运行时中执行脚本，不访问上游、不读取密钥。
// 后台测试器和 agent 接口共用此逻辑；脚本为空时原样返回样例。
func (b *backend) runApiUpstreamScriptTest(ctx context.Context, in apiUpstreamScriptTestRequest) (any, error) {
	if !apiUpstreamOperations[in.Operation] || (in.Stage != "request" && in.Stage != "response") {
		return nil, invalid("API 上游脚本操作或阶段无效")
	}
	if len([]rune(in.Script)) > 32768 {
		return nil, invalid("API 上游处理脚本过长")
	}
	if len(in.Sample) == 0 || string(in.Sample) == "null" {
		return nil, invalid("样例不能为空")
	}
	var sample any
	if err := json.Unmarshal(in.Sample, &sample); err != nil {
		return nil, invalid("样例 JSON 无效")
	}
	modelID := "sample-model"
	taskID := "sample-task"
	if m, ok := sample.(map[string]any); ok {
		if body, ok := m["body"].(map[string]any); ok {
			if value, ok := body["model"].(string); ok && strings.TrimSpace(value) != "" {
				modelID = strings.TrimSpace(value)
			}
		}
		for _, candidate := range []map[string]any{m} {
			for _, key := range []string{"taskId", "task_id", "id"} {
				if value, ok := candidate[key].(string); ok && strings.TrimSpace(value) != "" {
					taskID = strings.TrimSpace(value)
					break
				}
			}
		}
		if body, ok := m["body"].(map[string]any); ok {
			for _, key := range []string{"taskId", "task_id", "id"} {
				if value, ok := body[key].(string); ok && strings.TrimSpace(value) != "" {
					taskID = strings.TrimSpace(value)
					break
				}
			}
		}
		if query, ok := m["query"].(map[string]any); ok {
			for _, key := range []string{"taskId", "task_id", "id"} {
				if value, ok := query[key].(string); ok && strings.TrimSpace(value) != "" {
					taskID = strings.TrimSpace(value)
					break
				}
			}
		}
	}
	contextValue := map[string]any{
		"operation": in.Operation, "stage": in.Stage,
		"contentType": "application/json", "platformModelId": modelID, "upstreamModelId": modelID,
	}
	if in.Operation == "images.edit" {
		contextValue["contentType"] = "multipart/form-data"
	}
	if strings.Contains(in.Operation, ".query") {
		contextValue["taskId"] = taskID
	}
	if strings.TrimSpace(in.Script) == "" {
		return sample, nil
	}
	client := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
	if client == nil {
		return nil, &apiError{http.StatusServiceUnavailable, "SCRIPT_RUNTIME_UNAVAILABLE", "API 上游脚本运行时不可用"}
	}
	output, err := client.execute(ctx, scriptRuntimeRequest{Script: strings.TrimSpace(in.Script), Operation: in.Operation, Stage: in.Stage, Input: sample, Context: contextValue})
	if err != nil {
		var unavailable *scriptRuntimeUnavailableError
		if errors.As(err, &unavailable) {
			return nil, &apiError{http.StatusServiceUnavailable, "SCRIPT_RUNTIME_UNAVAILABLE", "API 上游脚本运行时不可用"}
		}
		return nil, &apiError{http.StatusUnprocessableEntity, "SCRIPT_EXECUTION_FAILED", "供应商请求处理脚本测试失败，请检查脚本和样例"}
	}
	var preview any
	if err := json.Unmarshal(output, &preview); err != nil {
		return nil, &apiError{http.StatusUnprocessableEntity, "SCRIPT_EXECUTION_FAILED", "供应商请求处理脚本输出无效"}
	}
	return preview, nil
}

func (b *backend) handleApiUpstreamScriptDiagnostics(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	client := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
	if client == nil {
		return &apiError{http.StatusServiceUnavailable, "SCRIPT_RUNTIME_UNAVAILABLE", "API 上游脚本运行时不可用"}
	}
	timeout := b.config.readyTimeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	diagnostics, err := client.diagnostics(ctx)
	if err != nil {
		return &apiError{http.StatusServiceUnavailable, "SCRIPT_RUNTIME_UNAVAILABLE", "API 上游脚本运行时不可用"}
	}
	writeJSON(w, http.StatusOK, diagnostics)
	return nil
}
