//go:build integration

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type videoWorkerFixture struct {
	user, model, member, version, group string
	adapter                             map[string]any
}

func seedVideoWorkerFixture(t *testing.T, b *backend, endpoint string, retries int) videoWorkerFixture {
	t.Helper()
	ctx := context.Background()
	uid, _ := seedAuthUser(t, b)
	configureModerationIntegration(t, b, endpoint)
	setStorageTestSetting(t, b, "SYSTEM_ASSETS_BUCKET_NAME", "system")
	setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", "generations")
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	model := seedModerationProvider(t, b, endpoint, false)
	f := videoWorkerFixture{user: uid, model: model}
	var raw []byte
	if err := b.db.QueryRow(ctx, `SELECT m.id,v.id,g.group_id,v.configuration FROM image_backend_member m JOIN image_backend_member_api_config c ON c.member_id=m.id JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id JOIN image_backend_member_group g ON g.member_id=m.id WHERE m.supported_model_ids::jsonb @> jsonb_build_array($1::text)`, model).Scan(&f.member, &f.version, &f.group, &raw); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(raw, &f.adapter)
	f.adapter["videoSubmissionRetryCount"] = retries
	f.adapter["authentication"] = map[string]any{"mode": "bearer"}
	f.adapter["videoInputFormat"] = "base64"
	f.adapter["modelMappings"] = []any{map[string]any{"modelId": model, "upstreamModelId": "upstream-model"}}
	f.adapter["operations"] = map[string]any{"videos.generate": map[string]any{"path": "/submit"}, "videos.query": map[string]any{"path": "/original/{task_id}"}}
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE id=$1`, f.version, mustJSON(f.adapter)); err != nil {
		t.Fatal(err)
	}
	creditTestWallet(t, b, uid, 20)
	creditTestBatch(t, b, uid, "purchase", 20, nil)
	return f
}

func seedVideoWorkerTask(t *testing.T, b *backend, f videoWorkerFixture) string {
	t.Helper()
	id := newRequestID()
	metadata := map[string]any{"backendGroupId": f.group, "backendGroupSnapshot": map[string]any{"id": f.group, "contentSafetyEnabled": false}, "moderationEnabled": false, "generateAudio": true, "negativePrompt": "avoid blur", "videoBillingSnapshot": map[string]any{"quotedCredits": 1.25}, "videoLedgerNamespace": "video"}
	if _, err := b.db.Exec(context.Background(), `INSERT INTO video_generation(id,user_id,model,prompt,duration_seconds,aspect_ratio,resolution,status,stage,principal_scope,output_width,output_height,storage_bucket,metadata) VALUES($1,$2,$3,'video prompt',5,'16:9','720p','pending','created','user:'||$2,1280,720,'generations',$4)`, id, f.user, f.model, mustJSON(metadata)); err != nil {
		t.Fatal(err)
	}
	return id
}

func readVideoWorkerState(t *testing.T, b *backend, id string) (string, string, float64, int) {
	t.Helper()
	var stage, job string
	var credits float64
	var failures int
	if err := b.db.QueryRow(context.Background(), `SELECT stage,COALESCE(upstream_job_id,''),credits_consumed,api_adapter_query_failure_count FROM video_generation WHERE id=$1`, id).Scan(&stage, &job, &credits, &failures); err != nil {
		t.Fatal(err)
	}
	return stage, job, credits, failures
}

func TestVideoWorkerResolvesEnabledChildGroupsAndStopsAtDisabledNodes(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	var submits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			submits.Add(1)
		}
		_, _ = io.WriteString(w, `{"status":"processing","taskId":"nested-task"}`)
	}))
	defer server.Close()
	f := seedVideoWorkerFixture(t, b, server.URL, 0)
	child := seedImagePricingGroup(t, b, false, nil, nil)
	opsFixtureExec(t, b, `UPDATE image_backend_group SET metadata=$2 WHERE id=$1`, f.group, mustJSON(map[string]any{"childGroupIds": []string{child}}))
	opsFixtureExec(t, b, `UPDATE image_backend_group SET metadata=$2 WHERE id=$1`, child, mustJSON(map[string]any{"childGroupIds": []string{f.group}}))
	opsFixtureExec(t, b, `UPDATE image_backend_member_group SET group_id=$2 WHERE member_id=$1`, f.member, child)
	// A higher-priority image-only account advertising the same model must
	// never receive a video's submission through a default guessed URL.
	opsFixtureExec(t, b, `UPDATE image_backend_member SET priority=10 WHERE id=$1`, f.member)
	seedImagePricingMember(t, b, child, f.model, server.URL, false, 0)
	pricing, err := loadGoVideoPricingContext(ctx, b.db, f.user, "", "")
	if err != nil || !pricing.Reachable[f.model] {
		t.Fatalf("nested model unavailable: %v %v", pricing.Reachable, err)
	}
	id := seedVideoWorkerTask(t, b, f)
	worker := &mediaWorker{backend: b}
	if err = worker.processDurableVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	stage, job, _, _ := readVideoWorkerState(t, b, id)
	if submits.Load() != 1 || stage != "polling" || job != "nested-task" {
		t.Fatalf("nested supplier not submitted: %d %s %s", submits.Load(), stage, job)
	}
	var selected string
	if err = b.db.QueryRow(ctx, `SELECT api_adapter_member_id FROM video_generation WHERE id=$1`, id).Scan(&selected); err != nil || selected != f.member {
		t.Fatalf("wrong operation supplier selected: %s %v", selected, err)
	}
	opsFixtureExec(t, b, `UPDATE image_backend_group SET is_enabled=false WHERE id=$1`, child)
	pricing, err = loadGoVideoPricingContext(ctx, b.db, f.user, "", "")
	if err != nil || pricing.Reachable[f.model] {
		t.Fatalf("disabled descendant remains reachable: %v", err)
	}
	blocked := seedVideoWorkerTask(t, b, f)
	if err = worker.processDurableVideo(ctx, blocked); err != nil {
		t.Fatal(err)
	}
	stage, _, credits, _ := readVideoWorkerState(t, b, blocked)
	if submits.Load() != 1 || stage != "failed" || credits != 0 {
		t.Fatalf("disabled group submitted: %d %s %.2f", submits.Load(), stage, credits)
	}
}

func TestVideoWorkerAcceptedTaskKeepsVersionAndRetriesPollAndDownload(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	var submits, polls, downloads atomic.Int32
	var id string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST":
			submits.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["client_request_id"] != id || body["model"] != "upstream-model" || body["aspect_ratio"] != "16:9" || body["generate_audio"] != true || body["negative_prompt"] != "avoid blur" {
				t.Errorf("video adapter fields missing: %#v", body)
			}
			w.Header().Set("Retry-After", "12")
			_, _ = io.WriteString(w, `{"status":"processing","taskId":"accepted/id 1","poll_url":"https://do-not-follow.invalid/steal"}`)
		case r.URL.Path == "/result.mp4":
			var stage, token string
			if err := b.db.QueryRow(ctx, `SELECT stage,COALESCE(claim_token,'') FROM video_generation WHERE id=$1`, id).Scan(&stage, &token); err != nil {
				t.Error(err)
			}
			if stage != "downloading" || token == "" {
				t.Errorf("download began before durable stage/claim: %s %q", stage, token)
			}
			if downloads.Add(1) == 1 {
				w.WriteHeader(503)
				return
			}
			_, _ = io.WriteString(w, "video-output")
		default:
			if r.URL.EscapedPath() != "/original/accepted%2Fid%201" || r.Header.Get("Authorization") != "Bearer rotated" {
				t.Errorf("accepted task changed route or credentials: %s", r.URL)
			}
			if polls.Add(1) == 1 {
				w.Header().Set("Retry-After", "21")
				w.WriteHeader(503)
				return
			}
			_, _ = io.WriteString(w, `{"status":"completed","video_url":"/result.mp4"}`)
		}
	}))
	defer server.Close()
	f := seedVideoWorkerFixture(t, b, server.URL, 1)
	id = seedVideoWorkerTask(t, b, f)
	worker := &mediaWorker{backend: b}
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	stage, job, credits, _ := readVideoWorkerState(t, b, id)
	if stage != "polling" || job != "accepted/id 1" || credits != 1.25 {
		t.Fatalf("accepted state %s %s %v", stage, job, credits)
	}
	var due time.Time
	if err := b.db.QueryRow(ctx, `SELECT next_poll_at FROM video_generation WHERE id=$1`, id).Scan(&due); err != nil {
		t.Fatal(err)
	}
	if time.Until(due) < 10*time.Second {
		t.Fatal("Retry-After omitted")
	}
	newVersion := newRequestID()
	f.adapter["baseUrl"] = "https://never-use-new-version.invalid"
	if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member_api_adapter_version(id,member_id_snapshot,revision,credential_scope,configuration) VALUES($1,$2,2,'test',$3)`, newVersion, f.member, mustJSON(f.adapter)); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member_api_config SET current_adapter_version_id=$2,api_key='rotated' WHERE member_id=$1`, f.member, newVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member SET is_enabled=false WHERE id=$1`, f.member); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `DELETE FROM image_backend_member_group WHERE member_id=$1`, f.member); err != nil {
		t.Fatal(err)
	}
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	stage, job, credits, failures := readVideoWorkerState(t, b, id)
	if stage != "polling" || job != "accepted/id 1" || credits != 1.25 || failures != 0 {
		t.Fatal("transient poll failure lost accepted state")
	}
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	stage, _, _, _ = readVideoWorkerState(t, b, id)
	if stage != "downloading" {
		t.Fatal("transient download failure was not durable")
	}
	setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", "new-generation-bucket")
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	stage, _, _, _ = readVideoWorkerState(t, b, id)
	if stage != "completed" || submits.Load() != 1 || polls.Load() != 2 || downloads.Load() != 2 {
		t.Fatalf("video recovery %s submit=%d poll=%d download=%d", stage, submits.Load(), polls.Load(), downloads.Load())
	}
	data, err := os.ReadFile(filepath.Join(b.config.storagePath, "generations", f.user, "videos", id+".mp4"))
	if err != nil || string(data) != "video-output" {
		t.Fatal("download changed immutable bucket")
	}
	for range 2 {
		if err := worker.processVideo(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	var events, total, leases, attempts int
	if err = b.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM user_output_usage_event WHERE output_kind='video' AND source_task_id=$1),(SELECT total_video_seconds FROM user_usage_summary WHERE user_id=$2),(SELECT count(*) FROM image_backend_member_lease WHERE id=$3),(SELECT count(*) FROM video_generation_submission_attempt WHERE video_generation_id=$1)`, id, f.user, videoWorkerLeaseID(id)).Scan(&events, &total, &leases, &attempts); err != nil {
		t.Fatal(err)
	}
	if events != 1 || total != 5 || leases != 0 || attempts != 1 {
		t.Fatalf("completion projections %d %d %d %d", events, total, leases, attempts)
	}
	balance, batches, count := creditState(t, b, f.user)
	if balance != 18.75 || batches != 18.75 || count != 1 {
		t.Fatalf("video replay double charged/refunded: %v %v %d", balance, batches, count)
	}
}

func TestVideoWorkerQueryContractFailuresRefundAfterThreeAndRetainLedger(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	var submits, polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			submits.Add(1)
			_, _ = io.WriteString(w, `{"id":"accepted","status":"processing"}`)
			return
		}
		polls.Add(1)
		_, _ = io.WriteString(w, `{"broken":`)
	}))
	defer server.Close()
	f := seedVideoWorkerFixture(t, b, server.URL, 1)
	id := seedVideoWorkerTask(t, b, f)
	worker := mediaWorker{backend: b}
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	for n := 1; n <= 3; n++ {
		if err := worker.processVideo(ctx, id); err != nil {
			t.Fatal(err)
		}
		stage, _, credits, failures := readVideoWorkerState(t, b, id)
		if n < 3 && (stage != "polling" || credits != 1.25 || failures != n) {
			t.Fatalf("query failure prematurely settled: %s %v %d", stage, credits, failures)
		}
		if n == 3 && (stage != "failed" || credits != 0) {
			t.Fatal("three query failures did not refund")
		}
	}
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	balance, batches, count := creditState(t, b, f.user)
	if balance != 20 || batches != 20 || count != 2 || submits.Load() != 1 || polls.Load() != 3 {
		t.Fatalf("failed video settlement %v %v %d submit=%d poll=%d", balance, batches, count, submits.Load(), polls.Load())
	}
}

func TestVideoWorkerSerializesConcurrentSubmitAndFencesLostClaim(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	entered, release := make(chan struct{}), make(chan struct{})
	var submits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		submits.Add(1)
		close(entered)
		<-release
		_, _ = io.WriteString(w, `{"status":"processing","taskId":"accepted"}`)
	}))
	defer server.Close()
	f := seedVideoWorkerFixture(t, b, server.URL, 0)
	id := seedVideoWorkerTask(t, b, f)
	worker := mediaWorker{backend: b}
	done := make(chan error, 1)
	go func() { done <- worker.processVideo(ctx, id) }()
	<-entered
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	if submits.Load() != 1 {
		t.Fatal("concurrent task was submitted twice")
	}
	if _, err := b.db.Exec(ctx, `UPDATE video_generation SET claim_token='new-owner' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err == nil || !strings.Contains(err.Error(), "claim lost") {
		t.Fatalf("stale worker not fenced: %v", err)
	}
	stage, job, credits, _ := readVideoWorkerState(t, b, id)
	if stage != "submitting" || job != "" || credits != 1.25 {
		t.Fatalf("stale worker mutated result: %s %s %v", stage, job, credits)
	}
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	stage, _, _, _ = readVideoWorkerState(t, b, id)
	if stage != "retrying" || submits.Load() != 1 {
		t.Fatal("interrupted submit reissued without bounded recovery")
	}
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	stage, _, credits, _ = readVideoWorkerState(t, b, id)
	if stage != "failed" || credits != 0 || submits.Load() != 1 {
		t.Fatal("exhausted submission was not refunded")
	}
}

func TestVideoWorkerRetryBudgetAndFailoverRemainInsideAuthorizedGroup(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	var original, outsider, backup atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Header.Get("Authorization") {
		case "Bearer test":
			original.Add(1)
			w.WriteHeader(429)
		case "Bearer backup":
			backup.Add(1)
			_, _ = io.WriteString(w, `{"status":"processing","id":"accepted"}`)
		default:
			outsider.Add(1)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	f := seedVideoWorkerFixture(t, b, server.URL, 1)
	id := seedVideoWorkerTask(t, b, f)
	for _, outside := range []bool{true, false} {
		member, version, group := newRequestID(), newRequestID(), f.group
		priority, key := 0, "outside"
		if !outside {
			priority, key = 100, "backup"
		} else {
			group = newRequestID()
			if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_group(id,name,is_enabled) VALUES($1,'Outside group',true)`, group); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member(id,type,name,supported_model_ids,priority) VALUES($1,'api','Retry test',$2,$3)`, member, mustJSON([]string{f.model}), priority); err != nil {
			t.Fatal(err)
		}
		if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member_group(id,member_id,group_id) VALUES($1,$2,$3)`, newRequestID(), member, group); err != nil {
			t.Fatal(err)
		}
		if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member_api_adapter_version(id,member_id_snapshot,revision,credential_scope,configuration) VALUES($1,$2,1,'test',$3)`, version, member, mustJSON(f.adapter)); err != nil {
			t.Fatal(err)
		}
		if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member_api_config(member_id,api_key,current_adapter_version_id,credential_scope) VALUES($1,$2,$3,'test')`, member, key, version); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = b.db.Exec(ctx, `DELETE FROM video_generation WHERE id=$1`, id)
			_, _ = b.db.Exec(ctx, `DELETE FROM image_backend_member WHERE id=$1`, member)
			if outside {
				_, _ = b.db.Exec(ctx, `DELETE FROM image_backend_group WHERE id=$1`, group)
			}
		})
	}
	worker := mediaWorker{backend: b}
	for range 3 {
		if err := worker.processVideo(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	stage, _, credits, _ := readVideoWorkerState(t, b, id)
	if stage != "polling" || credits != 1.25 || original.Load() != 2 || backup.Load() != 1 || outsider.Load() != 0 {
		t.Fatalf("retry escaped group or budget %s %v %d %d %d", stage, credits, original.Load(), backup.Load(), outsider.Load())
	}
	var attempts, failed int
	if err := b.db.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE failure_code='rate_limited') FROM video_generation_submission_attempt WHERE video_generation_id=$1`, id).Scan(&attempts, &failed); err != nil {
		t.Fatal(err)
	}
	if attempts != 3 || failed != 2 {
		t.Fatalf("attempt ledger %d %d", attempts, failed)
	}
}

func TestVideoWorkerNativeProtocolsEncodeStagedFramesAndPollOriginalIdentity(t *testing.T) {
	for _, mode := range []string{"gemini", "seedance"} {
		t.Run(mode, func(t *testing.T) {
			b := integrationBackend(t)
			ctx := context.Background()
			var posts, polls atomic.Int32
			frame := []byte("native-video-frame")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					posts.Add(1)
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if mode == "gemini" {
						if r.URL.Path != "/v1beta/models/upstream-model:predictLongRunning" || r.Header.Get("x-goog-api-key") != "test" || r.Header.Get("Authorization") != "" {
							t.Error("Gemini native request route/auth mismatch")
						}
						instances, _ := body["instances"].([]any)
						if len(instances) != 1 {
							t.Fatal("Gemini instances omitted")
						}
						instance, _ := instances[0].(map[string]any)
						image, _ := instance["image"].(map[string]any)
						inline, _ := image["inlineData"].(map[string]any)
						parameters, _ := body["parameters"].(map[string]any)
						if inline["data"] != base64.StdEncoding.EncodeToString(frame) || inline["mimeType"] != "image/png" || parameters["durationSeconds"] != "5" || parameters["aspectRatio"] != "16:9" {
							t.Errorf("Gemini body mismatch %#v", body)
						}
						_, _ = io.WriteString(w, `{"name":"models/upstream-model/operations/native-job","done":false}`)
					} else {
						if r.URL.Path != "/api/v3/contents/generations/tasks" || r.Header.Get("Authorization") != "Bearer test" {
							t.Error("Seedance native request route/auth mismatch")
						}
						content, _ := body["content"].([]any)
						if len(content) != 2 {
							t.Fatal("Seedance content omitted")
						}
						image, _ := content[1].(map[string]any)
						source, _ := image["image_url"].(map[string]any)
						if source["url"] != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(frame) || body["ratio"] != "16:9" || body["generate_audio"] != true || body["model"] != "upstream-model" {
							t.Errorf("Seedance body mismatch %#v", body)
						}
						_, _ = io.WriteString(w, `{"id":"native-job","status":"running"}`)
					}
					return
				}
				polls.Add(1)
				if mode == "gemini" {
					if r.URL.Path != "/v1beta/models/upstream-model/operations/native-job" {
						t.Error("Gemini native poll path")
					}
					_, _ = io.WriteString(w, `{"name":"models/upstream-model/operations/native-job","done":false}`)
				} else {
					if r.URL.Path != "/api/v3/contents/generations/tasks/native-job" {
						t.Error("Seedance native poll path")
					}
					_, _ = io.WriteString(w, `{"id":"native-job","status":"running"}`)
				}
			}))
			defer server.Close()
			f := seedVideoWorkerFixture(t, b, server.URL, 0)
			f.model = "veo31"
			f.adapter["modelMappings"] = []any{map[string]any{"modelId": f.model, "upstreamModelId": "upstream-model"}}
			if _, err := b.db.Exec(ctx, `UPDATE image_backend_member SET supported_model_ids=$2 WHERE id=$1`, f.member, mustJSON([]string{f.model})); err != nil {
				t.Fatal(err)
			}
			id := seedVideoWorkerTask(t, b, f)
			f.adapter["videoProtocolMode"] = mode
			f.adapter["operations"].(map[string]any)["videos.generate"] = map[string]any{"path": "/must-be-ignored", "requestScript": "throw new Error('native ignores scripts');"}
			if _, err := b.db.Exec(ctx, `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE id=$1`, f.version, mustJSON(f.adapter)); err != nil {
				t.Fatal(err)
			}
			key := f.user + "/video-inputs/" + id + "/attempt/first-frame.png"
			if err := b.putStorageObject(ctx, "generations", key, frame, "image/png"); err != nil {
				t.Fatal(err)
			}
			manifest := map[string]any{"firstFrame": map[string]any{"source": "storage", "storageBucket": "generations", "storageKey": key, "mimeType": "image/png", "byteLength": len(frame)}}
			if _, err := b.db.Exec(ctx, `UPDATE video_generation SET input_manifest=$2,metadata=(metadata::jsonb||'{"negativePrompt":""}'::jsonb)::json WHERE id=$1`, id, mustJSON(manifest)); err != nil {
				t.Fatal(err)
			}
			worker := mediaWorker{backend: b}
			for range 2 {
				if err := worker.processVideo(ctx, id); err != nil {
					t.Fatal(err)
				}
			}
			stage, _, credits, _ := readVideoWorkerState(t, b, id)
			if stage != "polling" || credits != 1.25 || posts.Load() != 1 || polls.Load() != 1 {
				t.Fatalf("native state %s %v posts=%d polls=%d", stage, credits, posts.Load(), polls.Load())
			}
		})
	}
}

func TestVideoWorkerWaitsForMemberCapacityAndRefundsAfterDeadline(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		_, _ = io.WriteString(w, `{"status":"processing","id":"accepted"}`)
	}))
	defer server.Close()
	f := seedVideoWorkerFixture(t, b, server.URL, 0)
	id := seedVideoWorkerTask(t, b, f)
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member SET concurrency=1 WHERE id=$1`, f.member); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member_lease(id,member_id,owner_token,expires_at) VALUES($1,$2,'another-worker',now()+interval '1 hour')`, newRequestID(), f.member); err != nil {
		t.Fatal(err)
	}
	worker := mediaWorker{backend: b}
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	stage, _, credits, _ := readVideoWorkerState(t, b, id)
	if stage != "charged" || credits != 1.25 || posts.Load() != 0 {
		t.Fatal("capacity-exhausted provider was submitted")
	}
	var attempts int
	var deadline *time.Time
	if err := b.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM video_generation_submission_attempt WHERE video_generation_id=$1),capacity_wait_deadline_at FROM video_generation WHERE id=$1`, id).Scan(&attempts, &deadline); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 || deadline == nil {
		t.Fatal("capacity wait consumed submission attempt or lacks deadline")
	}
	if _, err := b.db.Exec(ctx, `UPDATE video_generation SET capacity_wait_deadline_at=now()-interval '1 minute' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if err := worker.processVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	stage, _, credits, _ = readVideoWorkerState(t, b, id)
	if stage != "failed" || credits != 0 || posts.Load() != 0 {
		t.Fatal("capacity wait deadline did not refund")
	}
	if balance, _, count := creditState(t, b, f.user); balance != 20 || count != 2 {
		t.Fatalf("capacity refund ledger %v %d", balance, count)
	}
}
