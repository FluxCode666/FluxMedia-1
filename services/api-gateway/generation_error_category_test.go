package main

import "testing"

func TestGenerationErrorCategoriesPreserveSLADenominator(t *testing.T) {
	for _, test := range []struct{ message, category string }{
		{"no available image quota | insufficient_quota", "platform"},
		{"upstream returned 401 Unauthorized", "platform"},
		{"too many requests: rate limit", "platform"},
		{"aliyun moderation failed: service unavailable", "platform"},
		{"content blocked by aliyun moderation: service unavailable", "moderation"},
		{"safety_violations: socket closed", "moderation"},
		{"image_unsafe image_generation_user_error", "moderation"},
		{"Sorry, I can’t help with this request", "moderation"},
		{"抱歉，我无法帮助处理这个请求。", "moderation"},
		{"riskLevel: high", "moderation"},
		{"OMNI-MODERATION rejected content", "moderation"},
		{"not a valid image", "user_request"},
		{"unsupported image mode: palette", "user_request"},
		{"the reference image is empty", "user_request"},
		{"API key quota exceeded", "user_request"},
		{"Invalid or missing API key", "user_request"},
		{"invalid moderation parameter violates the content policy", "user_request"},
		{"invalid image mode: moderation failed", "platform"},
		{"upstream invalid input image_generation_user_error", "user_request"},
		{"sorryish upstream was blocked", "platform"},
		{"unexpected upstream response", "platform"},
		{"", "platform"},
	} {
		t.Run(test.message, func(t *testing.T) {
			if got := classifyGenerationError(&test.message); got != test.category {
				t.Fatalf("got %s, want %s", got, test.category)
			}
			if got := adminStatusErrorCategory(&test.message); got != test.category {
				t.Fatalf("admin and homepage categories differ: %s, want %s", got, test.category)
			}
		})
	}
	if classifyGenerationError(nil) != "platform" {
		t.Fatal("unknown platform failure excluded from SLA")
	}
}
