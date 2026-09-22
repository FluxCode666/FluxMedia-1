package main

import (
	"strings"
	"testing"
	"time"
)

func TestOperationsExportCursorAndCSVValues(t *testing.T) {
	c := operationsExportCursor{"owner", "2026-09-14T01:02:03.123456Z", "task"}
	token := encodeOperationsExportCursor(c, "secret")
	decoded, e := decodeOperationsExportCursor(token, "owner", "secret")
	if e != nil || decoded != c {
		t.Fatalf("cursor: %v %v", decoded, e)
	}
	for _, bad := range []struct{ token, owner, secret string }{{token, "other", "secret"}, {token, "owner", "wrong"}, {token + "x", "owner", "secret"}, {"eyJzdWIiOiJvd25lciJ9", "owner", "secret"}} {
		if _, e = decodeOperationsExportCursor(bad.token, bad.owner, bad.secret); e == nil {
			t.Fatal("accepted forged export cursor")
		}
	}
	for _, test := range []struct {
		amount         int64
		currency, want string
	}{{120, "USD", "1.20"}, {-1, "USD", "-0.01"}, {1234, "BHD", "1.234"}, {125, "VND", "125"}, {-9223372036854775808, "USD", "-92233720368547758.08"}} {
		if got := formatExportAmount(test.amount, test.currency); got != test.want {
			t.Fatalf("money %s %s", got, test.want)
		}
	}
	for _, value := range []string{"=SUM(1,2)", "+cmd", "-cmd", "@x", "\tformula", "\rformula"} {
		if !strings.HasPrefix(csvCell(value), "'") {
			t.Fatalf("unsafe formula %q", value)
		}
	}
	zone, _ := time.LoadLocation("America/New_York")
	got, e := formatOperationsExportDate("2024-03-10T07:00:00.123456Z", zone)
	if e != nil || got != "2024-03-10T03:00:00.123-04:00" {
		t.Fatalf("timezone %s %v", got, e)
	}
	if _, e = validateOperationsExportWatermarks([]byte(`{}`)); e == nil {
		t.Fatal("accepted incomplete snapshot")
	}
}
