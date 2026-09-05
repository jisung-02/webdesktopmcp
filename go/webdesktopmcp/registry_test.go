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

func TestExecuteForwardSameFrameAllowed(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "frameA", "mine", nil)

	env.s.Send("frameA", map[string]any{
		"kind": "executeForward", "requestId": "ex-3", "name": "mine",
		"input": map[string]any{}, "fromOrigin": "http://any",
	})
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "execute" && m["name"] == "mine"
	})
	if res["name"] != "mine" {
		t.Fatalf("result = %v", res)
	}
}

func TestExecuteForwardSuccessRoundTrip(t *testing.T) {
	env := newTestServer(t)
	env.s.SetFrameOrigin("frameA", "http://app")
	env.s.SetFrameOrigin("frameB", "http://app")
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
	env.s.SetFrameOrigin("frameA", "http://app")
	env.s.SetFrameOrigin("frameB", "http://app")
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
	env.rec.waitFor(t, time.Second, func(m map[string]any) bool { return m["kind"] == "abort" && m["_frameId"] == "frameA" })
	env.s.reg.mu.Lock()
	defer env.s.reg.mu.Unlock()
	if len(env.s.reg.forwards) != 0 {
		t.Fatal("timed out forward leaked")
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
	// - own tools visible (tool_b_open)
	// - tool_a_restricted requires explicit fromOrigins despite exposure
	// - tool_a_open has no exposedTo → hidden from other origins
	env.s.Send("frameB", map[string]any{
		"kind": "getToolsRequest", "requestId": "gt-1", "forOrigin": "http://b.origin",
	})
	res := env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "getToolsResponse" && m["requestId"] == "gt-1"
	})
	names := toolNames(res["tools"])
	want := map[string]bool{"tool_b_open": true}
	if len(names) != len(want) {
		t.Fatalf("names = %v", names)
	}
	for name := range names {
		if !want[name] {
			t.Fatalf("unexpected tool %q in %v", name, names)
		}
	}

	env.s.SetFrameOrigin("frameC", "http://b.origin")
	// fromOrigins adds the exposed foreign tool; same-origin tools remain.
	env.s.Send("frameC", map[string]any{
		"kind": "getToolsRequest", "requestId": "gt-2", "forOrigin": "http://b.origin",
		"fromOrigins": []string{"http://a.origin"},
	})
	res = env.rec.waitFor(t, 2*time.Second, func(m map[string]any) bool {
		return m["kind"] == "getToolsResponse" && m["requestId"] == "gt-2"
	})
	names = toolNames(res["tools"])
	if len(names) != 2 || !names["tool_a_restricted"] || !names["tool_b_open"] {
		t.Fatalf("filtered names = %v", names)
	}

	env.s.SetFrameOrigin("frameC", "http://other.origin")
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
	if len(names) != 0 {
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
// Host provenance takes precedence over renderer origin claims
// ---------------------------------------------------------------------------

func TestRegisterCannotOverwriteHostOrigin(t *testing.T) {
	env := newTestServer(t)
	env.s.SetFrameOrigin("frameA", "http://trusted")
	mustRegister(t, env, "frameA", "originated", func(msg map[string]any) {
		msg["_origin"] = "tauri://localhost"
	})
	tools := env.s.reg.list()
	if len(tools) != 1 || tools[0].origin != "http://trusted" {
		t.Fatalf("origin = %+v", tools)
	}
}

// ---------------------------------------------------------------------------
// Late executeResult after timeout is ignored (no panic, no double reply)
// ---------------------------------------------------------------------------

func TestLateExecuteResultIgnored(t *testing.T) {
	env := newTestServer(t)
	env.s.reg.handleExecuteResult("a", "inv-never-issued", true, "1", "", "")
	env.s.reg.handleExecuteResult("a", "", true, "1", "", "")
	// No reply messages may appear for unknown invocations.
	time.Sleep(20 * time.Millisecond)
	if n := len(env.rec.snapshot()); n != 0 {
		t.Fatalf("unexpected messages: %v", env.rec.snapshot())
	}
}

func TestCallerOriginCannotBeForged(t *testing.T) {
	env := newTestServer(t)
	env.s.SetFrameOrigin("owner", "http://owner")
	env.s.SetFrameOrigin("caller", "http://evil")
	mustRegister(t, env, "owner", "secret", func(m map[string]any) { m["exposedTo"] = []string{"http://trusted"} })
	env.s.Send("caller", map[string]any{"kind": "executeForward", "requestId": "forge", "name": "secret", "fromOrigin": "http://trusted"})
	if res := env.rec.snapshot()[1]; res["errorCode"] != "SecurityError" {
		t.Fatalf("forged origin accepted: %v", res)
	}
	env.s.Send("caller", map[string]any{"kind": "getToolsRequest", "requestId": "list", "forOrigin": "http://trusted"})
	if names := toolNames(env.rec.snapshot()[2]["tools"]); len(names) != 0 {
		t.Fatalf("forged list: %v", names)
	}
}

func TestOwnToolsRemainWithAdditionalOrigins(t *testing.T) {
	env := newTestServer(t)
	env.s.SetFrameOrigin("a", "http://a")
	mustRegister(t, env, "a", "own", nil)
	env.s.Send("a", map[string]any{"kind": "getToolsRequest", "requestId": "q", "fromOrigins": []string{"http://other"}})
	if names := toolNames(env.rec.snapshot()[1]["tools"]); len(names) != 1 || !names["own"] {
		t.Fatalf("same-origin tool missing: %v", names)
	}
}

func TestForwardCancelAndResultOwnership(t *testing.T) {
	env := newTestServer(t)
	env.s.SetFrameOrigin("owner", "http://app")
	env.s.SetFrameOrigin("caller", "http://app")
	mustRegister(t, env, "owner", "work", nil)
	env.s.Send("caller", map[string]any{"kind": "executeForward", "requestId": "q", "name": "work"})
	execute := env.rec.snapshot()[1]
	env.s.Send("intruder", map[string]any{"kind": "executeResult", "invocationId": execute["invocationId"], "ok": true, "result": "1"})
	if len(env.rec.snapshot()) != 2 {
		t.Fatal("non-owner completed invocation")
	}
	env.s.Send("intruder", map[string]any{"kind": "cancelForward", "requestId": "q"})
	if len(env.s.reg.forwards) != 1 {
		t.Fatal("other caller cancelled invocation")
	}
	if ack := env.s.Send("caller", map[string]any{"kind": "cancelForward", "requestId": "q"}); ack["ok"] != true {
		t.Fatalf("cancel rejected: %v", ack)
	}
	if len(env.s.reg.forwards) != 0 {
		t.Fatal("cancel did not clean pending")
	}
	if m := env.rec.snapshot()[2]; m["kind"] != "abort" || m["invocationId"] != execute["invocationId"] {
		t.Fatalf("missing abort: %v", m)
	}
}

func TestInvokePreCancelledDoesNotDispatch(t *testing.T) {
	env := newTestServer(t)
	mustRegister(t, env, "a", "work", nil)
	done := make(chan struct{})
	close(done)
	if _, err := env.s.reg.invoke("work", nil, done); err == nil {
		t.Fatal("expected cancellation")
	}
	if len(env.rec.snapshot()) != 1 {
		t.Fatal("cancelled invocation dispatched")
	}
}

func TestInvocationOwnerGoneAndTimeoutAbort(t *testing.T) {
	for _, action := range []string{"gone", "timeout"} {
		t.Run(action, func(t *testing.T) {
			env := newTestServer(t)
			mustRegister(t, env, "owner", "work", nil)
			env.s.reg.setTimeout(20 * time.Millisecond)
			finished := make(chan error, 1)
			go func() { _, err := env.s.reg.invoke("work", nil, nil); finished <- err }()
			execute := env.rec.waitFor(t, time.Second, func(m map[string]any) bool { return m["kind"] == "execute" })
			env.s.Send("intruder", map[string]any{"kind": "executeResult", "invocationId": execute["invocationId"], "ok": true, "result": "1"})
			if action == "gone" {
				env.s.FrameGone("owner")
			}
			select {
			case err := <-finished:
				if err == nil {
					t.Fatal("non-owner completed call")
				}
			case <-time.After(time.Second):
				t.Fatal("call not released")
			}
			env.s.reg.mu.Lock()
			n := len(env.s.reg.pending)
			env.s.reg.mu.Unlock()
			if n != 0 {
				t.Fatal("pending call leaked")
			}
			if action == "timeout" {
				env.rec.waitFor(t, time.Second, func(m map[string]any) bool {
					return m["kind"] == "abort" && m["invocationId"] == execute["invocationId"]
				})
			}
		})
	}
}

func TestForwardFrameGoneCleansPending(t *testing.T) {
	for _, frame := range []string{"caller", "owner"} {
		t.Run(frame, func(t *testing.T) {
			env := newTestServer(t)
			env.s.SetFrameOrigin("owner", "http://app")
			env.s.SetFrameOrigin("caller", "http://app")
			mustRegister(t, env, "owner", "work", nil)
			env.s.Send("caller", map[string]any{"kind": "executeForward", "requestId": "q", "name": "work"})
			env.s.FrameGone(frame)
			if len(env.s.reg.forwards) != 0 {
				t.Fatal("forward leaked")
			}
			m := env.rec.snapshot()[2]
			if frame == "caller" && m["kind"] != "abort" {
				t.Fatalf("missing owner abort: %v", m)
			}
			if frame == "owner" && (m["kind"] != "executeForwardResult" || m["ok"] != false) {
				t.Fatalf("missing caller failure: %v", m)
			}
		})
	}
}

func TestSameOriginRestrictedToolsRemainAccessible(t *testing.T) {
	env := newTestServer(t)
	env.s.SetFrameOrigin("owner", "http://app")
	env.s.SetFrameOrigin("caller", "http://app")
	mustRegister(t, env, "owner", "work", func(m map[string]any) { m["exposedTo"] = []string{"http://other"} })
	env.s.Send("caller", map[string]any{"kind": "getToolsRequest", "requestId": "q"})
	if !toolNames(env.rec.snapshot()[1]["tools"])["work"] {
		t.Fatal("same-origin tool hidden")
	}
	env.s.Send("caller", map[string]any{"kind": "executeForward", "requestId": "f", "name": "work"})
	if m := env.rec.snapshot()[2]; m["kind"] != "execute" || m["_frameId"] != "owner" {
		t.Fatalf("not routed to owner: %v", m)
	}
	env.s.Send("caller", map[string]any{"kind": "cancelForward", "requestId": "f"})
}
