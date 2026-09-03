package webdesktopmcp

import (
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// executeForward: in-page agent (frameB) calls frameA's tool
// ---------------------------------------------------------------------------

func TestExecuteForwardSecurityError(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "restricted_tool", func(msg map[string]any) {
		msg["exposedTo"] = []string{"http://trusted.origin"}
	})

	env.s.Send("frameB", map[string]any{
		"kind": "executeForward", "requestId": "ex-1", "name": "restricted_tool",
		"input": map[string]any{}, "fromOrigin": "http://evil.origin",
	})
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "executeForwardResult" && m["requestId"] == "ex-1"
	})
	if res["ok"] != false || res["errorCode"] != "SecurityError" {
		t.Fatalf("result = %v", res)
	}
	if errMsg, _ := res["errorMessage"].(string); !strings.Contains(errMsg, "not exposed") {
		t.Fatalf("errorMessage = %v", res["errorMessage"])
	}
}

func TestExecuteForwardNotFound(t *testing.T) {
	env := newTestServer(t)
	env.s.Send("frameB", map[string]any{
		"kind": "executeForward", "requestId": "ex-2", "name": "ghost",
		"input": map[string]any{}, "fromOrigin": "http://any",
	})
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "executeForwardResult" && m["requestId"] == "ex-2"
	})
	if res["errorCode"] != "NotFoundError" {
		t.Fatalf("result = %v", res)
	}
}

func TestExecuteForwardSameFrameRejected(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "mine", nil)

	env.s.Send("frameA", map[string]any{
		"kind": "executeForward", "requestId": "ex-3", "name": "mine",
		"input": map[string]any{}, "fromOrigin": "http://any",
	})
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "executeForwardResult" && m["requestId"] == "ex-3"
	})
	if res["errorCode"] != "InvalidStateError" {
		t.Fatalf("result = %v", res)
	}
}

func TestExecuteForwardSuccessRoundTrip(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "shared_helper", nil)

	go func() {
		// frameA owns the tool: it receives the forwarded `execute`.
		execute := env.rec.waitFor(t, 3*time.Second, func(m map[string]any) bool {
			return m["kind"] == "execute" && m["name"] == "shared_helper"
		})
		env.s.Send("frameA", map[string]any{
			"kind": "executeResult", "invocationId": execute["invocationId"],
			"ok": true, "result": `"forwarded-result"`,
		})
	}()

	env.s.Send("frameB", map[string]any{
		"kind": "executeForward", "requestId": "ex-4", "name": "shared_helper",
		"input": map[string]any{"n": 1}, "fromOrigin": "http://agent",
	})
	res := env.rec.waitFor(t, 3*time.Second, func(m map[string]any) bool {
		return m["kind"] == "executeForwardResult" && m["requestId"] == "ex-4"
	})
	if res["ok"] != true || res["result"] != `"forwarded-result"` {
		t.Fatalf("result = %v", res)
	}
}

func TestExecuteForwardTimeout(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "slow_owner", nil)
	env.s.reg.setTimeout(80 * time.Millisecond)

	env.s.Send("frameB", map[string]any{
		"kind": "executeForward", "requestId": "ex-5", "name": "slow_owner",
		"input": map[string]any{}, "fromOrigin": "http://agent",
	})
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "executeForwardResult" && m["requestId"] == "ex-5"
	})
	if res["ok"] != false || res["errorCode"] != "TimeoutError" {
		t.Fatalf("result = %v", res)
	}
}

// ---------------------------------------------------------------------------
// getToolsRequest aggregation
// ---------------------------------------------------------------------------

func TestGetToolsRequestAggregation(t *testing.T) {
	env := newTestServer(t)
	env.s.SetFrameOrigin("frameA", "http://a.origin")
	env.s.SetFrameOrigin("frameB", "http://b.origin")
	mustRegister(t, env, "frameA", "tool_a_open", nil)
	mustRegister(t, env, "frameA", "tool_a_restricted", func(msg map[string]any) {
		msg["exposedTo"] = []string{"http://b.origin"}
	})
	mustRegister(t, env, "frameB", "tool_b_open", nil)

	// Caller frameB, forOrigin http://b.origin:
	// - own tools always visible (tool_b_open)
	// - tool_a_restricted exposed to http://b.origin → visible
	// - tool_a_open has no exposedTo → visible to everyone
	env.s.Send("frameB", map[string]any{
		"kind": "getToolsRequest", "requestId": "gt-1", "forOrigin": "http://b.origin",
	})
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "getToolsResponse" && m["requestId"] == "gt-1"
	})
	names := toolNames(res["tools"])
	want := map[string]bool{"tool_a_open": true, "tool_a_restricted": true, "tool_b_open": true}
	if len(names) != len(want) {
		t.Fatalf("names = %v", names)
	}
	for name := range names {
		if !want[name] {
			t.Fatalf("unexpected tool %q in %v", name, names)
		}
	}

	// fromOrigins filter: caller frameC owns nothing, so only tools whose
	// origin is http://a.origin pass (tool_b_open is dropped).
	env.s.Send("frameC", map[string]any{
		"kind": "getToolsRequest", "requestId": "gt-2", "forOrigin": "http://b.origin",
		"fromOrigins": []string{"http://a.origin"},
	})
	res = env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "getToolsResponse" && m["requestId"] == "gt-2"
	})
	names = toolNames(res["tools"])
	if len(names) != 2 || !names["tool_a_open"] || !names["tool_a_restricted"] {
		t.Fatalf("filtered names = %v", names)
	}

	// Restricted tool not exposed to the caller's origin is hidden.
	env.s.Send("frameC", map[string]any{
		"kind": "getToolsRequest", "requestId": "gt-3", "forOrigin": "http://other.origin",
	})
	res = env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "getToolsResponse" && m["requestId"] == "gt-3"
	})
	names = toolNames(res["tools"])
	if names["tool_a_restricted"] {
		t.Fatalf("restricted tool leaked: %v", names)
	}
	if !names["tool_a_open"] || !names["tool_b_open"] {
		t.Fatalf("open tools missing: %v", names)
	}
}

// toolNames extracts tool names whether the list is JSON-decoded ([]any of
// map[string]any) or a live Go message ([]map[string]any).
func toolNames(v any) map[string]bool {
	out := map[string]bool{}
	add := func(m map[string]any) {
		if n, ok := m["name"].(string); ok {
			out[n] = true
		}
	}
	switch tools := v.(type) {
	case []any:
		for _, t := range tools {
			if m, ok := t.(map[string]any); ok {
				add(m)
			}
		}
	case []map[string]any:
		for _, m := range tools {
			add(m)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Stale-frame pruning via `_session` (page reload recovery)
// ---------------------------------------------------------------------------

func TestSessionChangePrunesStaleFrameTools(t *testing.T) {
	env := newTestServer(t)

	// First page load: two tools, session S1.
	mustRegister(t, env, "frameA", "old_tool", func(msg map[string]any) {
		msg["_session"] = "S1"
	})
	mustRegister(t, env, "frameA", "another_old", func(msg map[string]any) {
		msg["_session"] = "S1"
	})

	// Same session double-register → rejected (page rolls back).
	env.s.Send("frameA", map[string]any{
		"kind": "register", "invocationId": "reg-dup-same-session",
		"tool":     map[string]any{"name": "old_tool", "description": "dup"},
		"_session": "S1",
	})
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "registerResult" && m["invocationId"] == "reg-dup-same-session"
	})
	if res["ok"] != false {
		t.Fatalf("same-session duplicate should be rejected: %v", res)
	}

	// Page reloads (new session S3): its first register wipes the stale tools.
	mustRegister(t, env, "frameA", "fresh_tool", func(msg map[string]any) {
		msg["_session"] = "S3"
	})
	tools := env.s.reg.list()
	if len(tools) != 1 || tools[0].name != "fresh_tool" {
		t.Fatalf("stale tools not pruned: %v", tools)
	}
	for _, tool := range tools {
		if tool.name == "old_tool" || tool.name == "another_old" {
			t.Fatalf("stale tool %q survived", tool.name)
		}
	}
}

func TestNoSessionSameFrameReRegisterRefreshes(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "refreshable", nil)

	// Without a session token, a same-frame re-register of the same name is an
	// in-place refresh (reload recovery for callers that do not send _session).
	env.s.Send("frameA", map[string]any{
		"kind": "register", "invocationId": "reg-refresh",
		"tool": map[string]any{"name": "refreshable", "description": "updated"},
	})
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "registerResult" && m["invocationId"] == "reg-refresh"
	})
	if res["ok"] != true {
		t.Fatalf("refresh rejected: %v", res)
	}
	tools := env.s.reg.list()
	if len(tools) != 1 || tools[0].decl["description"] != "updated" {
		t.Fatalf("refresh did not apply: %+v", tools[0].decl)
	}
}

// ---------------------------------------------------------------------------
// Origin stamping from the `_origin` message field
// ---------------------------------------------------------------------------

func TestRegisterOriginField(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "originated", func(msg map[string]any) {
		msg["_origin"] = "tauri://localhost"
	})
	tools := env.s.reg.list()
	if len(tools) != 1 || tools[0].origin != "tauri://localhost" {
		t.Fatalf("origin = %+v", tools)
	}
}

// ---------------------------------------------------------------------------
// Late executeResult after timeout is ignored (no panic, no double reply)
// ---------------------------------------------------------------------------

func TestLateExecuteResultIgnored(t *testing.T) {
	env := newTestServer(t)
	env.s.reg.handleExecuteResult("inv-never-issued", true, "1", "", "")
	env.s.reg.handleExecuteResult("", true, "1", "", "")
	// No reply messages may appear for unknown invocations.
	time.Sleep(20 * time.Millisecond)
	if n := len(env.rec.snapshot()); n != 0 {
		t.Fatalf("unexpected messages: %v", env.rec.snapshot())
	}
}
