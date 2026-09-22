//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// Exercise every UNION branch and tied timestamps against PostgreSQL. A query
// with an incorrect refund projection previously made even an empty list fail.
func TestUsageLogListsEverySourceAndPaginatesWithoutDuplicates(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	userID, email := seedAuthUser(t, b)
	_, otherEmail := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	otherCookie := signInTestUser(t, b, otherEmail)
	if _, err := b.db.Exec(ctx, `UPDATE analytics_read_model_state SET version=1,status='ready' WHERE read_model='credit_usage'`); err != nil {
		t.Fatal(err)
	}
	imageID, historicalID, videoID, operationID, refundID := newRequestID(), newRequestID(), newRequestID(), newRequestID(), newRequestID()
	at := time.Now().UTC().Add(-time.Minute).Truncate(time.Millisecond)
	for _, item := range []struct{ id, mode string }{{imageID, "generate"}, {historicalID, "retired"}} {
		if _, err := b.db.Exec(ctx, `INSERT INTO generation(id,user_id,prompt,model,status,metadata,usage_log_visible,created_at,completed_at) VALUES($1,$2,'private prompt','test-model','completed',json_build_object('mode',$3::text),true,$4,$4)`, item.id, userID, item.mode, at); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO video_generation(id,user_id,model,prompt,duration_seconds,aspect_ratio,resolution,status,principal_scope,output_width,output_height,created_at,completed_at) VALUES($1,$2,'test-video','private prompt',5,'16:9','720p','completed','user:'||$2,1280,720,$3,$3)`, videoID, userID, at); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ kind, id string }{{"image_generation", imageID}, {"image_generation", historicalID}, {"video_generation", videoID}, {"manual_consumption", operationID}} {
		if _, err := b.db.Exec(ctx, `INSERT INTO credit_usage_operation(user_id,operation_type,operation_id,operation_created_at,gross_consumed,net_consumed) VALUES($1,$2,$3,$4,3.50,3.50)`, userID, item.kind, item.id, at); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,operation_type,operation_id,operation_created_at,created_at) VALUES($1,$2,'refund',1.25,'SERVICE:image_generation','WALLET:'||$2,'image_generation',$3,$4,$4)`, refundID, userID, imageID, at); err != nil {
		t.Fatal(err)
	}
	type event struct {
		Kind     string  `json:"kind"`
		Ref      string  `json:"eventRef"`
		Business string  `json:"businessType"`
		Delta    float64 `json:"creditsDelta"`
	}
	var cursor *string
	seen := map[string]bool{}
	counts := map[string]int{}
	for page := 0; page < 6; page++ {
		input, _ := json.Marshal(map[string]any{"range": "7d", "limit": 1, "cursor": cursor})
		w := authRequest(t, b, "POST", "/api/credits/usage-log", string(input), cookie)
		if w.Code != http.StatusOK {
			t.Fatalf("list page %d: %d %s", page, w.Code, w.Body.String())
		}
		var output struct {
			Events     []event `json:"events"`
			NextCursor *string `json:"nextCursor"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &output); err != nil {
			t.Fatal(err)
		}
		if len(output.Events) != 1 {
			t.Fatalf("page %d: %+v", page, output)
		}
		e := output.Events[0]
		if seen[e.Ref] {
			t.Fatal("pagination repeated an event")
		}
		seen[e.Ref] = true
		counts[e.Business]++
		if e.Kind == "refund" && e.Delta != 1.25 || e.Kind == "request" && e.Delta != -3.5 {
			t.Fatalf("incorrect signed amount: %+v", e)
		}
		detailBody, _ := json.Marshal(map[string]any{"eventRef": e.Ref})
		detail := authRequest(t, b, "POST", "/api/credits/usage-log/detail", string(detailBody), cookie)
		if detail.Code != http.StatusOK {
			t.Fatalf("detail: %d %s", detail.Code, detail.Body.String())
		}
		other := authRequest(t, b, "POST", "/api/credits/usage-log/detail", string(detailBody), otherCookie)
		if other.Code != http.StatusNotFound {
			t.Fatalf("another user read event: %d", other.Code)
		}
		cursor = output.NextCursor
		if cursor == nil {
			break
		}
	}
	if len(seen) != 5 || counts["image"] != 1 || counts["video"] != 1 || counts["historical"] != 2 || counts["refund"] != 1 {
		t.Fatalf("missing sources: %v", counts)
	}
	w := authRequest(t, b, "POST", "/api/credits/usage-log", `{"businessType":"refund","status":"refund"}`, cookie)
	var filtered struct {
		Events []event `json:"events"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &filtered); err != nil || w.Code != 200 || len(filtered.Events) != 1 || filtered.Events[0].Kind != "refund" {
		t.Fatalf("refund filter: %d %s", w.Code, w.Body.String())
	}
	w = authRequest(t, b, "POST", "/api/credits/usage-log", `{}`, otherCookie)
	var empty struct {
		Events []event `json:"events"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &empty); err != nil || w.Code != 200 || len(empty.Events) != 0 {
		t.Fatalf("user scope: %d %s", w.Code, w.Body.String())
	}
}
