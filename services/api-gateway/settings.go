package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5"
)

func (b *backend) setting(ctx context.Context, key string, fallback any) (any, error) {
	var raw []byte
	err := b.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key=$1`, key).Scan(&raw)
	if err == nil {
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, fmt.Errorf("decode setting: %w", err)
		}
		return value, nil
	}
	if err != pgx.ErrNoRows {
		return nil, fmt.Errorf("read setting: %w", err)
	}
	if value, exists := os.LookupEnv(key); exists && value != "" {
		return value, nil
	}
	return fallback, nil
}
func (b *backend) settingString(ctx context.Context, key, fallback string) (string, error) {
	value, err := b.setting(ctx, key, fallback)
	if err != nil {
		return "", err
	}
	if value == nil {
		return fallback, nil
	}
	if s, ok := value.(string); ok {
		return s, nil
	}
	return fmt.Sprint(value), nil
}
func (b *backend) settingBool(ctx context.Context, key string, fallback bool) (bool, error) {
	value, err := b.setting(ctx, key, fallback)
	if err != nil {
		return false, err
	}
	switch v := value.(type) {
	case bool:
		return v, nil
	case string:
		if parsed, err := strconv.ParseBool(v); err == nil {
			return parsed, nil
		}
	}
	return fallback, nil
}
