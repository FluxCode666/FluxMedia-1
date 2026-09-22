package main

import (
	"testing"
	"time"
)

func TestPaymentAdminCalendarRanges(t *testing.T) {
	now := time.Date(2026, 3, 15, 18, 0, 0, 0, time.UTC)
	overview, err := resolvePaymentAdminRange("", "", "Asia/Shanghai", now, false)
	if err != nil {
		t.Fatal(err)
	}
	if overview.From != "2026-03-01" || overview.To != "2026-03-31" || len(overview.Dates) != 31 || overview.Start.Format(time.RFC3339) != "2026-02-28T16:00:00Z" || overview.End.Format(time.RFC3339) != "2026-03-31T16:00:00Z" {
		t.Fatalf("month=%+v", overview)
	}
	orders, err := resolvePaymentAdminRange("", "", "Asia/Shanghai", now, true)
	if err != nil || orders.From != "2026-03-10" || orders.To != "2026-03-16" {
		t.Fatalf("orders=%+v err=%v", orders, err)
	}
	dst, err := resolvePaymentAdminRange("2026-03-08", "2026-03-08", "America/New_York", now, false)
	if err != nil || dst.End.Sub(dst.Start) != 23*time.Hour {
		t.Fatalf("DST=%+v err=%v", dst, err)
	}
	for _, tc := range []struct {
		from, to string
		orders   bool
	}{
		{"2026-02-30", "2026-03-01", false}, {"2026-03-01", "", false}, {"2026-03-02", "2026-03-01", false},
		{"2025-01-01", "2026-03-01", false}, {"2026-04-01", "2026-04-01", false}, {"2026-03-01", "2027-01-01", false}, {"2026-03-01", "2026-03-17", true},
	} {
		if _, e := resolvePaymentAdminRange(tc.from, tc.to, "Asia/Shanghai", now, tc.orders); e == nil {
			t.Fatalf("accepted invalid range: %+v", tc)
		}
	}
}
