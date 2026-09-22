package main

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

func settingsObjectHasOnly(value map[string]any, keys ...string) bool {
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	for key := range value {
		if !allowed[key] {
			return false
		}
	}
	return value != nil
}
func validSettingsReferral(value any) bool {
	root := settingObject(value)
	if !settingsObjectHasOnly(root, "enabled", "inviter", "invitee") {
		return false
	}
	if _, ok := root["enabled"].(bool); !ok {
		return false
	}
	for _, key := range []string{"inviter", "invitee"} {
		side := settingObject(root[key])
		if side == nil {
			return false
		}
		n, ok := side["value"].(float64)
		if !ok || n < 0 {
			return false
		}
		switch side["mode"] {
		case "percentage":
			if n > 100 {
				return false
			}
		case "fixed":
			if n > 1000000 {
				return false
			}
		default:
			return false
		}
	}
	return true
}
func validSettingsLocalized(value any, max int) bool {
	object := settingObject(value)
	if !settingsObjectHasOnly(object, "zh", "en") {
		return false
	}
	for _, key := range []string{"zh", "en"} {
		text, ok := object[key].(string)
		text = strings.TrimSpace(text)
		if !ok || text == "" || utf8.RuneCountInString(text) > max {
			return false
		}
		object[key] = text
	}
	return true
}
func validSettingsSupportLink(raw any) bool {
	text, ok := raw.(string)
	if !ok {
		return false
	}
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > 2048 {
		return false
	}
	if strings.HasPrefix(text, "/") {
		return !strings.HasPrefix(text, "//") && !strings.Contains(text, `\`) && strings.IndexFunc(text, unicode.IsSpace) < 0
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.Host == "" {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	return parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")
}

var settingsSupportServiceID = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func validSettingsDashboardSupport(value any) bool {
	root := settingObject(value)
	if !settingsObjectHasOnly(root, "version", "officialSupport", "services") || root["version"] != float64(1) {
		return false
	}
	official := settingObject(root["officialSupport"])
	if !settingsObjectHasOnly(official, "enabled", "channel", "description", "qrCodeUrl", "actionLabel", "actionUrl") {
		return false
	}
	if _, ok := official["enabled"].(bool); !ok {
		return false
	}
	if !validSettingsLocalized(official["channel"], 120) || !validSettingsLocalized(official["description"], 500) || !validSettingsLocalized(official["actionLabel"], 120) || !validSettingsSupportLink(official["actionUrl"]) {
		return false
	}
	if qr, exists := official["qrCodeUrl"]; exists && !validSettingsSupportLink(qr) {
		return false
	}
	services, ok := root["services"].([]any)
	if !ok || len(services) > 12 {
		return false
	}
	ids := map[string]bool{}
	icons := map[string]bool{"discord": true, "telegram": true, "qq": true, "wechat": true, "twitter": true, "team": true, "documentation": true, "models": true, "support": true, "website": true}
	for _, raw := range services {
		service := settingObject(raw)
		if !settingsObjectHasOnly(service, "id", "enabled", "icon", "title", "description", "actionLabel", "url") {
			return false
		}
		id, ok := service["id"].(string)
		id = strings.TrimSpace(id)
		if !ok || len(id) > 64 || !settingsSupportServiceID.MatchString(id) || ids[id] {
			return false
		}
		ids[id] = true
		service["id"] = id
		if _, ok := service["enabled"].(bool); !ok {
			return false
		}
		icon, _ := service["icon"].(string)
		if !icons[icon] || !validSettingsLocalized(service["title"], 120) || !validSettingsLocalized(service["description"], 500) || !validSettingsLocalized(service["actionLabel"], 120) || !validSettingsSupportLink(service["url"]) {
			return false
		}
	}
	return true
}
