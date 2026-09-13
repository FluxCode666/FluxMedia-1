package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestAnnouncementPageParams(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/announcements?page=0&pageSize=200", nil)
	page, size := announcementPageParams(r, 20)
	if page != 1 || size != 100 {
		t.Fatalf("got page=%d size=%d", page, size)
	}
	if got := maxAnnouncementPages(41, 20); got != 3 {
		t.Fatalf("pages=%d", got)
	}
}

func TestValidateAnnouncementInput(t *testing.T) {
	now := time.Now()
	before := now.Add(-time.Minute)
	cases := []struct {
		name                     string
		title, content, severity string
		priority                 int
		published, expires       *time.Time
		wantErr                  bool
	}{
		{name: "valid", title: "系统更新", content: "服务已更新", severity: "info", priority: 1},
		{name: "short title", title: "x", content: "内容", wantErr: true},
		{name: "bad severity", title: "标题", content: "内容", severity: "danger", wantErr: true},
		{name: "bad priority", title: "标题", content: "内容", priority: 1000, wantErr: true},
		{name: "expiry before publish", title: "标题", content: "内容", published: &now, expires: &before, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateAnnouncementInput(tc.title, tc.content, tc.severity, tc.priority, tc.published, tc.expires); (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}
