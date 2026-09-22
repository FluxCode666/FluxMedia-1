//go:build integration

package main

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

func TestAnnouncementPartialUpdatePreservesConcurrentFields(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	uid, email := seedAuthUser(t, b)
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='super_admin' WHERE id=$1`, uid); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	id := newRequestID()
	if _, err := b.db.Exec(ctx, `INSERT INTO announcement(id,title,content,is_published,priority,created_by_user_id) VALUES($1,'Original title','Original content',true,8,$2)`, id, uid); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = b.db.Exec(ctx, `DELETE FROM announcement WHERE id=$1`, id) })
	var wg sync.WaitGroup
	for _, body := range []string{`{"title":"Changed title"}`, `{"content":"Changed content"}`} {
		wg.Add(1)
		go func(body string) {
			defer wg.Done()
			response := authRequest(t, b, "PATCH", "/api/admin/announcements/"+id, body, cookie)
			if response.Code != 200 {
				t.Error(response.Code, response.Body.String())
			}
		}(body)
	}
	wg.Wait()
	var title, content string
	var published bool
	var priority int
	if err := b.db.QueryRow(ctx, `SELECT title,content,is_published,priority FROM announcement WHERE id=$1`, id).Scan(&title, &content, &published, &priority); err != nil {
		t.Fatal(err)
	}
	if title != "Changed title" || content != "Changed content" || !published || priority != 8 {
		t.Fatalf("lost announcement fields: %s %s %v %d", title, content, published, priority)
	}
	for _, body := range []string{`{"priority":"wrong"}`, `{"title":null}`, `{"title":"x"}`} {
		response := authRequest(t, b, "PATCH", "/api/admin/announcements/"+id, body, cookie)
		if response.Code != 400 {
			t.Fatal(fmt.Sprintf("invalid patch accepted: %d %s", response.Code, response.Body.String()))
		}
	}
}
