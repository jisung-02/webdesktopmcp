package webdesktopmcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Test infrastructure: a fake frame is anything that (a) calls s.Send and
// (b) subscribed to the emitter (recorder) and replies via s.Send.
// ---------------------------------------------------------------------------

// frameRecorder captures every message the host emits and lets tests wait for
// specific messages — it plays the role of the page(s).
type frameRecorder struct {
	mu   sync.Mutex
	msgs []map[string]any
}

func newFrameRecorder() *frameRecorder { return &frameRecorder{} }

func (r *frameRecorder) emit(event string, data ...interface{}) {
	if event != "webdesktopmcp:message" || len(data) == 0 {
		return
	}
	msg, _ := data[0].(map[string]any)
	r.mu.Lock()
	r.msgs = append(r.msgs, msg)
	r.mu.Unlock()
}

func (r *frameRecorder) snapshot() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]map[string]any(nil), r.msgs...)
}

// waitFor polls until pred matches an emitted message or the timeout elapses.
func (r *frameRecorder) waitFor(t *testing.T, d time.Duration, pred func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(d)
	for {
		for _, m := range r.snapshot() {
			if pred(m) {
				return m
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for host message; got %v", d, r.snapshot())
		}
		time.Sleep(2 * time.Millisecond)
	}
}

type testEnv struct {
	s   *Server
	rec *frameRecorder
}

func newTestServer(t *testing.T) testEnv {
	t.Helper()
	dir := t.TempDir()
	s, err := New(Config{AppName: "TestApp", AppVersion: "1.2.3", Port: 0, RegistryDir: dir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	rec := newFrameRecorder()
	s.SetEventEmitter(rec.emit)
	return testEnv{s: s, rec: rec}
}

// mustRegister sends a register message and asserts both the ack and the
// registerResult were ok.
func mustRegister(t *testing.T, env testEnv, frameID, name string, mutate func(msg map[string]any)) {
	t.Helper()
	msg := map[string]any{
		"kind":         "register",
		"invocationId": fmt.Sprintf("reg-%s-%d", name, time.Now().UnixNano()),
		"tool":         map[string]any{"name": name, "description": "test tool " + name},
	}
	if mutate != nil {
		mutate(msg)
	}
	ack := env.s.Send(frameID, msg)
	if ack["ok"] != true {
		t.Fatalf("Send ack not ok: %v", ack)
	}
	invID := msg["invocationId"].(string)
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "registerResult" && m["invocationId"] == invID
	})
	if res["ok"] != true {
		t.Fatalf("register of %q rejected: %v", name, res["errorMessage"])
	}
}

// postMCP issues an authenticated JSON-RPC POST against the live endpoint.
func postMCP(t *testing.T, s *Server, method string, params any) (int, map[string]any) {
	t.Helper()
	payload := map[string]any{"jsonrpc": "2.0", "id": 1, "method": method}
	if params != nil {
		payload["params"] = params
	}
	return postRaw(t, s, payload, true)
}

func postRaw(t *testing.T, s *Server, payload any, withAuth bool) (int, map[string]any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, s.URL(), bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if withAuth {
		req.Header.Set("Authorization", "Bearer "+s.Token())
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("response is not JSON: %s", raw)
		}
	}
	return res.StatusCode, out
}

// ---------------------------------------------------------------------------
// Tools/call round trip (the core contract)
// ---------------------------------------------------------------------------

func TestToolsCallRoundTrip(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "get_answer", nil)

	// Fake frame: wait for the execute message, reply with executeResult.
	go func() {
		execute := env.rec.waitFor(t, 3*time.Second, func(m map[string]any) bool {
			return m["kind"] == "execute" && m["name"] == "get_answer"
		})
		if execute["invocationId"] == nil || execute["input"] == nil {
			t.Errorf("execute message missing fields: %v", execute)
		}
		env.s.Send("frameA", map[string]any{
			"kind":         "executeResult",
			"invocationId": execute["invocationId"],
			"ok":           true,
			"result":       `{"answer":42}`,
		})
	}()

	status, body := postMCP(t, env.s, "tools/call", map[string]any{
		"name": "get_answer", "arguments": map[string]any{"q": "life"},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	result, _ := body["result"].(map[string]any)
	if result == nil {
		t.Fatalf("missing result: %v", body)
	}
	if isError, _ := result["isError"].(bool); isError {
		t.Fatalf("unexpected isError: %v", result)
	}
	content, _ := result["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("content = %v", content)
	}
	text, _ := content[0].(map[string]any)["text"].(string)
	if text != `{"answer":42}` {
		t.Fatalf("text = %q", text)
	}
	structured, _ := result["structuredContent"].(map[string]any)
	if structured == nil || structured["answer"] != float64(42) {
		t.Fatalf("structuredContent = %v", result["structuredContent"])
	}
}

func TestToolsCallErrorResult(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "fragile", nil)

	go func() {
		execute := env.rec.waitFor(t, 3*time.Second, func(m map[string]any) bool {
			return m["kind"] == "execute" && m["name"] == "fragile"
		})
		env.s.Send("frameA", map[string]any{
			"kind": "executeResult", "invocationId": execute["invocationId"],
			"ok": false, "errorCode": "ExecutionError", "errorMessage": "boom",
		})
	}()

	status, body := postMCP(t, env.s, "tools/call", map[string]any{"name": "fragile"})
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	result := body["result"].(map[string]any)
	if result["isError"] != true {
		t.Fatalf("expected isError, got %v", result)
	}
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "boom") {
		t.Fatalf("text = %q", text)
	}
}

func TestToolsCallTimeout(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "sleepy", nil)
	env.s.reg.setTimeout(80 * time.Millisecond) // shrink the 120s default

	status, body := postMCP(t, env.s, "tools/call", map[string]any{"name": "sleepy"})
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	result := body["result"].(map[string]any)
	if result["isError"] != true {
		t.Fatalf("expected isError, got %v", result)
	}
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "timed out") {
		t.Fatalf("text = %q", text)
	}
}

func TestToolsCallUnknownTool(t *testing.T) {
	env := newTestServer(t)
	status, body := postMCP(t, env.s, "tools/call", map[string]any{"name": "nope"})
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	result := body["result"].(map[string]any)
	if result["isError"] != true {
		t.Fatalf("expected isError, got %v", result)
	}
	if text := result["content"].([]any)[0].(map[string]any)["text"].(string); !strings.Contains(text, "Unknown tool") {
		t.Fatalf("text = %q", text)
	}
}

// ---------------------------------------------------------------------------
// Registration semantics
// ---------------------------------------------------------------------------

func TestToolNameValidation(t *testing.T) {
	env := newTestServer(t)

	cases := []struct {
		note    string
		mutate  func(msg map[string]any)
		wantOK  bool
		wantErr string
	}{
		{"valid name", nil, true, ""},
		{
			note: "128 chars (max)",
			mutate: func(m map[string]any) {
				m["tool"] = map[string]any{"name": strings.Repeat("a", 128), "description": "d"}
			},
			wantOK: true,
		},
		{
			note: "129 chars",
			mutate: func(m map[string]any) {
				m["tool"] = map[string]any{"name": strings.Repeat("a", 129), "description": "d"}
			},
			wantErr: "Invalid tool name",
		},
		{
			note:    "empty name",
			mutate:  func(m map[string]any) { m["tool"].(map[string]any)["name"] = "" },
			wantErr: "Invalid tool name",
		},
		{
			note:    "invalid character",
			mutate:  func(m map[string]any) { m["tool"].(map[string]any)["name"] = "bad name!" },
			wantErr: "Invalid tool name",
		},
		{
			note:    "non-string name",
			mutate:  func(m map[string]any) { m["tool"].(map[string]any)["name"] = 42 },
			wantErr: "Invalid tool name",
		},
		{
			note:    "empty description",
			mutate:  func(m map[string]any) { m["tool"].(map[string]any)["description"] = "" },
			wantErr: "description is required",
		},
		{
			note:    "missing description",
			mutate:  func(m map[string]any) { delete(m["tool"].(map[string]any), "description") },
			wantErr: "description is required",
		},
		{
			note:    "inputSchema not an object",
			mutate:  func(m map[string]any) { m["tool"].(map[string]any)["inputSchema"] = "nope" },
			wantErr: "inputSchema",
		},
		{
			note:    "inputSchema.type not a string",
			mutate:  func(m map[string]any) { m["tool"].(map[string]any)["inputSchema"] = map[string]any{"type": 7} },
			wantErr: "inputSchema.type",
		},
		{
			note: "valid with schema and annotations",
			mutate: func(m map[string]any) {
				m["tool"].(map[string]any)["inputSchema"] = map[string]any{"type": "object", "properties": map[string]any{}}
				m["tool"].(map[string]any)["annotations"] = map[string]any{"readOnlyHint": true}
			},
			wantOK: true,
		},
		{
			note:    "annotations not an object",
			mutate:  func(m map[string]any) { m["tool"].(map[string]any)["annotations"] = true },
			wantErr: "annotations",
		},
		{
			note:    "missing tool object",
			mutate:  func(m map[string]any) { delete(m, "tool") },
			wantErr: "Tool must be an object",
		},
	}

	for i, tc := range cases {
		t.Run(tc.note, func(t *testing.T) {
			msg := map[string]any{
				"kind":         "register",
				"invocationId": fmt.Sprintf("reg-%d", i),
				"tool":         map[string]any{"name": fmt.Sprintf("tool_%d", i), "description": "d"},
			}
			if tc.mutate != nil {
				tc.mutate(msg)
			}
			ack := env.s.Send("frameA", msg)
			if ack["ok"] != true {
				t.Fatalf("Send ack not ok: %v", ack)
			}
			res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
				return m["kind"] == "registerResult" && m["invocationId"] == msg["invocationId"]
			})
			if tc.wantOK {
				if res["ok"] != true {
					t.Fatalf("expected ok, got %v", res)
				}
			} else {
				if res["ok"] != false {
					t.Fatalf("expected rejection, got %v", res)
				}
				if errMsg, _ := res["errorMessage"].(string); !strings.Contains(errMsg, tc.wantErr) {
					t.Fatalf("errorMessage %q does not contain %q", errMsg, tc.wantErr)
				}
			}
		})
	}
}

func TestDuplicateNameRejectedAcrossFrames(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "shared_name", nil)

	ack := env.s.Send("frameB", map[string]any{
		"kind":         "register",
		"invocationId": "reg-dup",
		"tool":         map[string]any{"name": "shared_name", "description": "clash"},
	})
	if ack["ok"] != true { // transport-level ack stays ok
		t.Fatalf("ack = %v", ack)
	}
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "registerResult" && m["invocationId"] == "reg-dup"
	})
	if res["ok"] != false {
		t.Fatalf("expected rejection, got %v", res)
	}
	if errMsg, _ := res["errorMessage"].(string); !strings.Contains(errMsg, "already used by another webview") {
		t.Fatalf("errorMessage = %v", res["errorMessage"])
	}
}

func TestToolsListHidesExposedTo(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "public_tool", nil)
	mustRegister(t, env, "frameB", "secret_tool", func(msg map[string]any) {
		msg["exposedTo"] = []string{"http://agent.internal"}
	})

	status, body := postMCP(t, env.s, "tools/list", nil)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	tools := body["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("expected 1 visible tool, got %v", tools)
	}
	tool := tools[0].(map[string]any)
	if tool["name"] != "public_tool" {
		t.Fatalf("tool = %v", tool)
	}
	if tool["description"] != "test tool public_tool" {
		t.Fatalf("description passthrough failed: %v", tool)
	}
	schema, _ := tool["inputSchema"].(map[string]any)
	if schema["type"] != "object" {
		t.Fatalf("default inputSchema missing: %v", tool)
	}
	meta, _ := tool["_meta"].(map[string]any)
	if meta["webdesktopmcp/frameId"] != "frameA" || meta["webdesktopmcp/origin"] != "" {
		t.Fatalf("_meta = %v", meta)
	}
}

func TestUnregisterAndFrameGone(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "temp_tool", nil)

	env.s.Send("frameA", map[string]any{"kind": "unregister", "invocationId": "u1", "name": "temp_tool"})
	// The tool must be gone from tools/list.
	_, body := postMCP(t, env.s, "tools/list", nil)
	if tools := body["result"].(map[string]any)["tools"].([]any); len(tools) != 0 {
		t.Fatalf("unregister failed: %v", tools)
	}

	// Re-register on two frames, then FrameGone(frameA) removes only frameA's.
	mustRegister(t, env, "frameA", "tool_a", nil)
	mustRegister(t, env, "frameB", "tool_b", nil)
	env.s.FrameGone("frameA")
	_, body = postMCP(t, env.s, "tools/list", nil)
	tools := body["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["name"] != "tool_b" {
		t.Fatalf("after FrameGone: %v", tools)
	}
}

// ---------------------------------------------------------------------------
// HTTP surface: health, auth, methods, JSON-RPC plumbing
// ---------------------------------------------------------------------------

func TestHealthEndpoint(t *testing.T) {
	env := newTestServer(t)
	res, err := http.Get(env.s.URL() + "?health=1")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["app"] != "TestApp" || body["version"] != "1.2.3" || body["protocolVersion"] != float64(ProtocolVersion) {
		t.Fatalf("health body = %v", body)
	}
}

func TestAuth(t *testing.T) {
	env := newTestServer(t)

	cases := []struct {
		note string
		hdr  string
		want int
	}{
		{"missing header", "", http.StatusUnauthorized},
		{"wrong scheme", "Basic " + env.s.Token(), http.StatusUnauthorized},
		{"wrong token", "Bearer definitely-not-it", http.StatusUnauthorized},
		{"correct token", "Bearer " + env.s.Token(), http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.note, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
			req, _ := http.NewRequest(http.MethodPost, env.s.URL(), bytes.NewReader(body))
			if tc.hdr != "" {
				req.Header.Set("Authorization", tc.hdr)
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", res.StatusCode, tc.want)
			}
		})
	}
}

func TestMethodAndPathRouting(t *testing.T) {
	env := newTestServer(t)
	client := &http.Client{}

	// GET /mcp without health param: authenticated → 405, unauthenticated → 401.
	req, _ := http.NewRequest(http.MethodGet, env.s.URL(), nil)
	req.Header.Set("Authorization", "Bearer "+env.s.Token())
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET /mcp authed = %d", res.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodGet, env.s.URL(), nil)
	res, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET /mcp unauthed = %d", res.StatusCode)
	}

	// DELETE with valid auth → 405.
	req, _ = http.NewRequest(http.MethodDelete, env.s.URL(), nil)
	req.Header.Set("Authorization", "Bearer "+env.s.Token())
	res, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE /mcp = %d", res.StatusCode)
	}

	// Other paths → 404 (even authenticated).
	req, _ = http.NewRequest(http.MethodPost, strings.TrimSuffix(env.s.URL(), "/mcp")+"/other", nil)
	req.Header.Set("Authorization", "Bearer "+env.s.Token())
	res, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("POST /other = %d", res.StatusCode)
	}
}

func TestJSONRPCPlumbing(t *testing.T) {
	env := newTestServer(t)

	t.Run("initialize echoes protocolVersion and reports serverInfo", func(t *testing.T) {
		_, body := postMCP(t, env.s, "initialize", map[string]any{"protocolVersion": "2024-11-05"})
		result := body["result"].(map[string]any)
		if result["protocolVersion"] != "2024-11-05" {
			t.Fatalf("protocolVersion = %v", result["protocolVersion"])
		}
		info := result["serverInfo"].(map[string]any)
		if info["name"] != "TestApp" || info["version"] != "1.2.3" {
			t.Fatalf("serverInfo = %v", info)
		}
		if _, ok := result["capabilities"].(map[string]any)["tools"]; !ok {
			t.Fatalf("capabilities = %v", result["capabilities"])
		}
	})

	t.Run("initialize without params defaults protocolVersion", func(t *testing.T) {
		_, body := postMCP(t, env.s, "initialize", nil)
		if v := body["result"].(map[string]any)["protocolVersion"]; v == "" {
			t.Fatalf("protocolVersion missing: %v", body)
		}
	})

	t.Run("ping", func(t *testing.T) {
		status, body := postMCP(t, env.s, "ping", nil)
		if status != http.StatusOK {
			t.Fatalf("status = %d", status)
		}
		if _, ok := body["result"].(map[string]any); !ok {
			t.Fatalf("ping result = %v", body)
		}
	})

	t.Run("method not found", func(t *testing.T) {
		_, body := postMCP(t, env.s, "resources/list", nil)
		errObj := body["error"].(map[string]any)
		if errObj["code"] != float64(-32601) {
			t.Fatalf("error = %v", errObj)
		}
	})

	t.Run("parse error", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodPost, env.s.URL(), strings.NewReader("{not json"))
		req.Header.Set("Authorization", "Bearer "+env.s.Token())
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("status = %d", res.StatusCode)
		}
		var body map[string]any
		_ = json.NewDecoder(res.Body).Decode(&body)
		if body["error"].(map[string]any)["code"] != float64(-32700) {
			t.Fatalf("body = %v", body)
		}
	})

	t.Run("notification accepted with empty 202", func(t *testing.T) {
		payload := map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}
		status, body := postRaw(t, env.s, payload, true)
		if status != http.StatusAccepted {
			t.Fatalf("status = %d", status)
		}
		if body != nil {
			t.Fatalf("expected empty body, got %v", body)
		}
	})

	t.Run("batch returns array responses", func(t *testing.T) {
		payload := []any{
			map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"},
			map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"},
		}
		body, _ := json.Marshal(payload)
		req, _ := http.NewRequest(http.MethodPost, env.s.URL(), bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+env.s.Token())
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", res.StatusCode)
		}
		var arr []map[string]any
		if err := json.NewDecoder(res.Body).Decode(&arr); err != nil {
			t.Fatal(err)
		}
		if len(arr) != 1 || arr[0]["id"] != float64(1) {
			t.Fatalf("batch responses = %v", arr)
		}
	})
}

// ---------------------------------------------------------------------------
// Confirm hook
// ---------------------------------------------------------------------------

func TestConfirmHook(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "risky_tool", nil)

	var gotName string
	var gotInput map[string]any
	env.s.SetConfirmHook(func(toolName string, input map[string]any) bool {
		gotName = toolName
		gotInput = input
		return false
	})

	_, body := postMCP(t, env.s, "tools/call", map[string]any{"name": "risky_tool", "arguments": map[string]any{"k": "v"}})
	if gotName != "risky_tool" || gotInput["k"] != "v" {
		t.Fatalf("hook args = %s %v", gotName, gotInput)
	}
	result := body["result"].(map[string]any)
	if result["isError"] != true {
		t.Fatalf("expected declined error, got %v", result)
	}
	if text := result["content"].([]any)[0].(map[string]any)["text"].(string); !strings.Contains(text, "declined") {
		t.Fatalf("text = %q", text)
	}

	// Allowing hook → the call proceeds to the frame (which we leave
	// unanswered; the timeout error proves execution was attempted).
	env.s.reg.setTimeout(100 * time.Millisecond)
	env.s.SetConfirmHook(func(string, map[string]any) bool { return true })
	_, body = postMCP(t, env.s, "tools/call", map[string]any{"name": "risky_tool"})
	text := body["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "timed out") {
		t.Fatalf("expected timeout (execute attempted), got %q", text)
	}

	// Panicking hook → error result, no crash.
	env.s.reg.setTimeout(2 * time.Second)
	env.s.SetConfirmHook(func(string, map[string]any) bool { panic("dialog exploded") })
	_, body = postMCP(t, env.s, "tools/call", map[string]any{"name": "risky_tool"})
	text = body["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "Confirmation failed") {
		t.Fatalf("text = %q", text)
	}
}

// ---------------------------------------------------------------------------
// Send ack contract + misc
// ---------------------------------------------------------------------------

func TestSendAckContract(t *testing.T) {
	env := newTestServer(t)

	cases := []struct {
		note    string
		frameID string
		message map[string]any
		wantOK  bool
	}{
		{"empty frameID", "", map[string]any{"kind": "log"}, false},
		{"nil message", "f", nil, false},
		{"missing kind", "f", map[string]any{"foo": 1}, false},
		{"unknown kind", "f", map[string]any{"kind": "wat"}, false},
		{"register without invocationId", "f", map[string]any{"kind": "register"}, false},
		{"valid log", "f", map[string]any{"kind": "log", "level": "debug", "message": "hi"}, true},
		{"toolRemoved", "f", map[string]any{"kind": "toolRemoved", "name": "x"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.note, func(t *testing.T) {
			ack := env.s.Send(tc.frameID, tc.message)
			if got, _ := ack["ok"].(bool); got != tc.wantOK {
				t.Fatalf("ack = %v, want ok=%v", ack, tc.wantOK)
			}
			if !tc.wantOK {
				if err, _ := ack["error"].(string); err == "" {
					t.Fatalf("missing error text: %v", ack)
				}
			}
		})
	}
}

func TestHandlerServesBootstrap(t *testing.T) {
	env := newTestServer(t)

	if script := env.s.InitScript(); script == "" || !strings.Contains(script, "__webDesktopMcpHost") ||
		!strings.Contains(script, "webdesktopmcp:message") {
		t.Fatal("InitScript does not look like the bootstrap")
	}

	srv := httptest.NewServer(env.s.Handler())
	defer srv.Close()

	res, err := http.Get(srv.URL + "/webdesktopmcp.js")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("content-type = %q", ct)
	}
	raw, _ := io.ReadAll(res.Body)
	if string(raw) != env.s.InitScript() {
		t.Fatal("served script differs from InitScript()")
	}

	// The same handler still serves MCP (authenticated ping).
	payload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 7, "method": "ping"})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/mcp", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+env.s.Token())
	res2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusOK {
		t.Fatalf("ping via Handler() = %d", res2.StatusCode)
	}

	// Unknown path → 404.
	res3, err := http.Get(srv.URL + "/definitely-not-here")
	if err != nil {
		t.Fatal(err)
	}
	res3.Body.Close()
	if res3.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown path = %d", res3.StatusCode)
	}
}

func TestSetFrameOriginFlowsToList(t *testing.T) {
	env := newTestServer(t)
	env.s.SetFrameOrigin("frameA", "http://localhost:3000")
	mustRegister(t, env, "frameA", "origin_tool", nil)

	_, body := postMCP(t, env.s, "tools/list", nil)
	tool := body["result"].(map[string]any)["tools"].([]any)[0].(map[string]any)
	meta := tool["_meta"].(map[string]any)
	if meta["webdesktopmcp/origin"] != "http://localhost:3000" {
		t.Fatalf("origin not stamped: %v", meta)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	s, err := New(Config{AppName: "CloseApp", RegistryDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestNewValidation(t *testing.T) {
	t.Run("empty AppName rejected", func(t *testing.T) {
		if _, err := New(Config{RegistryDir: t.TempDir()}); err == nil {
			t.Fatal("expected error for empty AppName")
		}
	})
	t.Run("busy port rejected", func(t *testing.T) {
		env := newTestServer(t)
		port := env.s.Port()
		if _, err := New(Config{AppName: "Other", Port: port, RegistryDir: t.TempDir()}); err == nil {
			t.Fatal("expected error for busy port")
		}
	})
}
