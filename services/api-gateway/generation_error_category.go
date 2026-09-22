package main

import (
	"regexp"
	"strings"
)

// These categories preserve the generation SLA contract used before migration.
// Upstream account quota/auth failures remain platform incidents; user quotas
// and rejected input do not enter the platform availability denominator.
var generationUserRequestPatterns = []string{
	"image provider invalid_request",
	"prompt_too_long",
	"提示词过长",
	"prompt too long",
	"chat input context",
	"too_many_images",
	"参考图最多",
	"too many reference images",
	"image_too_large",
	"image dimensions exceed",
	"decompression bomb",
	"the image data you provided does not represent a valid image",
	"not a valid image",
	"invalid image data",
	"invalid image file",
	"invalid image format",
	"unsupported image format",
	"invalid image mode",
	"unsupported image mode",
	"unable to decode image",
	"unable to decode the image",
	"failed to decode image",
	"could not decode image",
	"cannot decode image",
	"image decode failed",
	"invalid_mask_image_format",
	"积分不足",
	"insufficient credits",
	"insufficient_credits",
	"api key quota exceeded",
	"api key credit limit",
	"api_key_quota_exceeded",
	"not enabled for this plan",
	"feature is not enabled",
	"invalid model",
	"unsupported model",
	"prompt exceeds",
	"context prompt exceeds",
	"chat input context",
	"invalid quality",
	"invalid moderation",
	"invalid thinking",
	"invalid display size",
	"invalid resolution",
	"transparent background is not supported",
	"use widthxheight",
	"must be between",
	"total pixels",
	"no more than",
	"at least one source image",
	"source images must be",
	"reference images must be",
	"mask must be",
	"is empty",
	"exceeds the",
	"total upload size",
	"upload is too large",
	"invalid or missing api key",
	"account frozen",
}

var generationModerationFailurePatterns = []string{
	"aliyun moderation timed out",
	"aliyun moderation failed",
	"content moderation failed",
	"moderation skipped unexpectedly",
	"moderation timed out",
	"moderation failed",
	"socket hang up",
	"socket closed",
	"connection reset",
	"econnreset",
	"operation was aborted",
	"temporarily unavailable",
	"service unavailable",
}

var generationModerationPatterns = []string{
	"content failed moderation",
	"content blocked",
	"content policy",
	"content policy violation",
	"violates our content policy",
	"violates the content policy",
	"policy violation",
	"policy_violation",
	"safety policy",
	"safety system",
	"safety violation",
	"safety_violations",
	"request was rejected by the safety system",
	"rejected by the safety system",
	"blocked by the safety system",
	"flagged by the safety system",
	"flagged by the safety",
	"flagged for sexual content",
	"referenced image was flagged",
	"disallowed content",
	"unsafe content",
	"image_unsafe",
	"not allowed to generate",
	"targeted abusive text",
	"abusive text",
	"sexualized image",
	"sexually suggestive",
	"explicit sexual",
	"sexual content",
	"未能通过安全",
	"安全系统",
	"安全限制",
	"安全过滤器",
	"安全机制",
	"系统安全",
	"系统拦截",
	"系统拒绝",
	"生成系统审核",
	"生成系统的安全检查",
	"内容审查",
	"露骨",
	"性暗示",
	"明显性化",
	"非性化",
	"裸露",
	"自伤",
	"未成年人",
	"受版权保护",
	"敏感性亲密",
	"近距离打击",
	"打斗/攻击",
	"暴力伤害",
	"强烈恐怖伤害",
	"成人性",
	"不能帮助",
	"不能协助",
	"不能生成",
	"无法生成",
	"无法处理这张图",
	"无法直接生成",
	"omni-moderation",
	"risklevel",
}

var generationApologyPatterns = []string{
	"i can't",
	"i cannot",
	"i won't",
	"i couldn't",
	"can't help",
	"can't create",
	"can't generate",
	"can't complete",
	"can't process",
	"cannot help",
	"cannot create",
	"cannot generate",
	"cannot complete",
	"cannot process",
	"couldn't complete",
	"could not complete",
	"not able to",
	"not allowed",
	"request was rejected",
	"request is rejected",
	"was rejected",
	"blocked",
	"flagged",
	"abusive",
	"copyright",
	"protected",
	"sexualized",
	"explicit",
	"我不能",
	"不能生成",
	"不能协助",
	"不能帮助",
	"不能按",
	"不能保留",
	"不能将",
	"不能处理",
	"我无法",
	"无法生成",
	"无法处理",
	"无法帮助",
	"无法按",
	"未能",
	"拒绝",
	"拦截",
	"安全",
	"审核",
	"受版权保护",
	"人身辱骂",
	"辱骂",
	"不允许",
}

var generationSorryPattern = regexp.MustCompile(`\bsorry\b`)

func generationErrorMatches(value string, patterns []string) bool {
	for _, pattern := range patterns {
		if strings.Contains(value, pattern) {
			return true
		}
	}
	return false
}

func classifyGenerationError(message *string) string {
	if message == nil {
		return "platform"
	}
	value := strings.ToLower(strings.NewReplacer("’", "'", "‘", "'", string(rune(96)), "'").Replace(*message))
	rejection := generationErrorMatches(value, []string{"content blocked by aliyun moderation", "moderation_blocked", "safety_violations"})
	if !rejection && generationErrorMatches(value, generationModerationFailurePatterns) {
		return "platform"
	}
	if generationErrorMatches(value, generationUserRequestPatterns) {
		return "user_request"
	}
	apology := (generationSorryPattern.MatchString(value) || strings.Contains(value, "抱歉")) && generationErrorMatches(value, generationApologyPatterns)
	if generationErrorMatches(value, generationModerationPatterns) || apology {
		return "moderation"
	}
	if strings.Contains(value, "image_generation_user_error") || strings.Contains(value, "user_error") {
		return "user_request"
	}
	return "platform"
}
