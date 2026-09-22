package main

import (
	"net"
	"testing"
)

func TestPublicImageURLsRejectPrivateAndRebindingTargets(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "169.254.169.254", "10.2.3.4", "172.20.1.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::a00:1"} {
		if publicMediaIP(net.ParseIP(ip)) {
			t.Errorf("private target allowed: %s", ip)
		}
	}
	for _, raw := range []string{"http://example.com/image.png", "https://127.0.0.1/x", "https://user:pass@example.com/x", "https://[::1]/x"} {
		if validatePublicMediaURL(raw) == nil {
			t.Errorf("unsafe URL allowed: %s", raw)
		}
	}
	if !publicMediaIP(net.ParseIP("8.8.8.8")) || validatePublicMediaURL("https://example.com/image.png") != nil {
		t.Fatal("public HTTPS rejected")
	}
}
