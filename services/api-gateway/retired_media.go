package main

import "net/http"

// These products were removed before the Go migration (f1cbacc9). Keep an
// explicit retirement response; never enqueue or charge for an obsolete API.
func (b *backend) handleRetiredConversation(w http.ResponseWriter, r *http.Request) error {
	return &apiError{http.StatusGone, "DEPRECATED_ENDPOINT", "对话、Responses 和 Agent 接口已下线，请使用图片或视频生成接口"}
}

func (b *backend) handleRetiredEditableFile(w http.ResponseWriter, r *http.Request) error {
	return &apiError{http.StatusGone, "DEPRECATED_ENDPOINT", "该接口已下线，当前版本不提供可编辑文件生成"}
}
