package main

import (
	"testing"
	"time"
)

func TestOperationsRangeCalendarPresetsAndDST(t *testing.T) {
	now := time.Date(2024, 3, 12, 2, 0, 0, 0, time.UTC)
	r, e := resolveOperationsRange(now, "America/New_York", "2024-03-10", map[string]any{"range": map[string]any{"kind": "custom", "from": "2024-03-09", "to": "2024-03-11"}, "granularity": "week"})
	if e != nil {
		t.Fatal(e)
	}
	if r["dayCount"] != 3 || r["availability"] != "partial_epoch" || r["today"] != "2024-03-11" || operationsTime(r["end"]).Sub(operationsTime(r["start"])) != 69*time.Hour {
		t.Fatalf("DST/today range incorrect: %v", r)
	}
	buckets := r["buckets"].([]any)
	if len(buckets) != 2 || buckets[0].(map[string]any)["key"] != "week:2024-03-04" || buckets[1].(map[string]any)["key"] != "week:2024-03-11" {
		t.Fatalf("Monday buckets: %v", buckets)
	}
	prev := r["previous"].(map[string]any)
	if prev["from"] != "2024-03-06" || prev["to"] != "2024-03-08" || prev["availability"] != "pre_epoch" {
		t.Fatalf("comparison: %v", prev)
	}
	for kind, from := range map[string]string{"default": "2024-02-11", "this_week": "2024-03-11", "this_month": "2024-03-01", "this_year": "2024-01-01"} {
		r, e := resolveOperationsRange(now, "America/New_York", "2020-01-01", map[string]any{"range": map[string]any{"kind": kind}})
		if e != nil || r["from"] != from {
			t.Fatalf("preset %s: %v %v", kind, r, e)
		}
	}
	r, e = resolveOperationsRange(now, "UTC", "2020-01-01", map[string]any{"range": map[string]any{"kind": "custom", "from": "2020-01-01", "to": "2024-03-11"}, "granularity": "month"})
	if e != nil || r["dayCount"].(int) < 1500 {
		t.Fatalf("long range was truncated: %v", e)
	}
	for _, in := range []map[string]any{{"userId": "spoof"}, {"granularity": "year"}, {"range": map[string]any{"kind": "custom", "from": "2024-03-12", "to": "2024-03-13"}}, {"range": map[string]any{"kind": "custom", "from": "2024-02-30", "to": "2024-03-01"}}} {
		if _, e := resolveOperationsRange(now, "UTC", "2020-01-01", in); e == nil {
			t.Fatalf("accepted invalid input %v", in)
		}
	}
}
