package main

import "testing"

func TestGoVideoQuoteTokenBindsPrincipalAndDigest(t *testing.T) {
	t.Setenv("BETTER_AUTH_SECRET", "test-video-quote-secret")
	token, err := encodeGoVideoQuoteToken("session:user-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatalf("encode token: %v", err)
	}
	if err := assertGoVideoQuoteToken(token, "session:user-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if err := assertGoVideoQuoteToken(token, "session:other", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); err == nil {
		t.Fatal("token accepted for another principal")
	}
	if err := assertGoVideoQuoteToken(token, "session:user-1", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"); err == nil {
		t.Fatal("stale quote token accepted")
	}
	mutated := token[:len(token)-1] + "A"
	if err := assertGoVideoQuoteToken(mutated, "session:user-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); err == nil {
		t.Fatal("tampered token accepted")
	}
}
