package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const settingsEnvBegin = "# BEGIN GPT2IMAGE ADMIN SETTINGS"
const settingsEnvEnd = "# END GPT2IMAGE ADMIN SETTINGS"

var settingsEnvBlock = regexp.MustCompile(regexp.QuoteMeta(settingsEnvBegin) + `[\s\S]*?` + regexp.QuoteMeta(settingsEnvEnd))
var settingsEnvWriteMu sync.Mutex

func buildSettingsEnvBlock(values map[string]storedSystemSetting) string {
	keys := []string{}
	for key, row := range values {
		d, ok := systemSettingDefinitionByKey[key]
		if ok && !d.ManagedByDedicatedOperation && row.Value != nil {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	lines := []string{settingsEnvBegin}
	for _, key := range keys {
		value := toSettingText(values[key].Value)
		var encoded bytes.Buffer
		encoder := json.NewEncoder(&encoded)
		encoder.SetEscapeHTML(false)
		_ = encoder.Encode(value)
		quoted := bytes.TrimSuffix(encoded.Bytes(), []byte("\n"))
		line := key + "=" + string(quoted)
		if strings.Contains(line, settingsEnvBegin) || strings.Contains(line, settingsEnvEnd) {
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(append(lines, settingsEnvEnd), "\n")
}
func applySettingsEnvBlock(current, managed string) (string, error) {
	if strings.Contains(current, settingsEnvBegin) {
		if !settingsEnvBlock.MatchString(current) {
			return "", invalid("环境配置托管块缺少结束标记")
		}
		return settingsEnvBlock.ReplaceAllStringFunc(current, func(string) string { return managed }), nil
	}
	return strings.TrimLeft(strings.TrimRight(current, " \t\r\n")+"\n\n"+managed+"\n", " \t\r\n"), nil
}
func settingsEnvTargets(target string) ([]string, error) {
	if strings.TrimSpace(target) != "" {
		absolute, err := filepath.Abs(target)
		if err != nil {
			return nil, err
		}
		return []string{absolute}, nil
	}
	if configured := strings.TrimSpace(os.Getenv("SYSTEM_SETTINGS_ENV_FILES")); configured != "" {
		result := []string{}
		seen := map[string]bool{}
		for _, item := range filepath.SplitList(configured) {
			absolute, err := filepath.Abs(item)
			if err != nil {
				return nil, err
			}
			if !seen[absolute] {
				result = append(result, absolute)
				seen[absolute] = true
			}
		}
		return result, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	for _, base := range []string{cwd, filepath.Join(cwd, "../..")} {
		dir := filepath.Join(base, "apps/web")
		if stat, err := os.Stat(dir); err == nil && stat.IsDir() {
			return []string{filepath.Join(dir, ".env.local")}, nil
		}
	}
	return []string{filepath.Join(cwd, ".env.local")}, nil
}
func syncSettingsEnvFiles(values map[string]storedSystemSetting, target string) ([]string, error) {
	targets, err := settingsEnvTargets(target)
	if err != nil {
		return nil, err
	}
	if len(values) == 0 {
		return []string{}, nil
	}
	managed := buildSettingsEnvBlock(values)
	settingsEnvWriteMu.Lock()
	defer settingsEnvWriteMu.Unlock()
	written := []string{}
	for _, path := range targets {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, fmt.Errorf("create settings env directory: %w", err)
		}
		current, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("read settings env file: %w", err)
		}
		next, err := applySettingsEnvBlock(string(current), managed)
		if err != nil {
			return nil, err
		}
		if err := writeSettingsEnvFile(path, []byte(next)); err != nil {
			return nil, err
		}
		written = append(written, path)
	}
	return written, nil
}
func writeSettingsEnvFile(path string, content []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".settings-env-*")
	if err != nil {
		return fmt.Errorf("create temporary settings file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err := temp.Write(content); err != nil {
		temp.Close()
		return fmt.Errorf("write settings env file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("sync settings env file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close settings env file: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace settings env file: %w", err)
	}
	return nil
}
