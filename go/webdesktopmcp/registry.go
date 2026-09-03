// Tool registry for the webdesktopmcp Wails host.
//
// Mirrors packages/server/src/registry.ts (see docs/protocol.md): app-wide
// unique tool names, pending invocation routing, cross-frame executeForward
// with exposedTo enforcement, and getTools aggregation.

package webdesktopmcp

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"sync"
	"time"
)

// ProtocolVersion is the webdesktopmcp wire protocol version implemented by
// this package (docs/protocol.md).
const ProtocolVersion = 1

// defaultInvocationTimeout is how long the host waits for a webview to answer
// an `execute` before failing the call (docs/protocol.md recommends 120s).
const defaultInvocationTimeout = 120 * time.Second

var toolNameRE = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

// sendFunc delivers a host message to a frame. The Server wires this to the
// configured event emitter ("webdesktopmcp:message").
type sendFunc func(frameID string, msg map[string]any)

// isValidToolName reports whether name satisfies the W3C grammar: 1–128
// characters of [A-Za-z0-9_.-].
func isValidToolName(v any) bool {
	s, ok := v.(string)
	return ok && toolNameRE.MatchString(s)
}

// toolEntry is a registered tool: the raw ToolDeclaration plus provenance.
type toolEntry struct {
	decl      map[string]any // raw ToolDeclaration (name/title/description/inputSchema/annotations)
	name      string
	origin    string
	frameID   string
	exposedTo []string
}

// info renders the RegisteredToolInfo wire shape (declaration + provenance).
func (t *toolEntry) info() map[string]any {
	info := make(map[string]any, len(t.decl)+3)
	for k, v := range t.decl {
		info[k] = v
	}
	info["origin"] = t.origin
	info["frameId"] = t.frameID
	if len(t.exposedTo) > 0 {
		info["exposedTo"] = append([]string(nil), t.exposedTo...)
	}
	return info
}

// isExposedTo mirrors the TS helper: tools without exposedTo are public.
func isExposedTo(t *toolEntry, origin string) bool {
	if len(t.exposedTo) == 0 {
		return true
	}
	for _, o := range t.exposedTo {
		if o == origin {
			return true
		}
	}
	return false
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// validateDeclaration checks a ToolDeclaration per docs/protocol.md and
// packages/protocol validateToolDeclaration. Returns "" when valid.
func validateDeclaration(decl map[string]any) string {
	if decl == nil {
		return "Tool must be an object."
	}
	name, _ := decl["name"].(string)
	if !isValidToolName(name) {
		return fmt.Sprintf("Invalid tool name: must be 1-128 characters of [A-Za-z0-9_.-], got %s.", mustJSON(decl["name"]))
	}
	if d, ok := decl["description"].(string); !ok || d == "" {
		return fmt.Sprintf("Tool %q: description is required and must be a non-empty string.", name)
	}
	if schema, present := decl["inputSchema"]; present && schema != nil {
		m, ok := schema.(map[string]any)
		if !ok {
			return fmt.Sprintf("Tool %q: inputSchema must be a JSON Schema object.", name)
		}
		if _, ok := m["type"].(string); !ok {
			return fmt.Sprintf("Tool %q: inputSchema.type must be a string.", name)
		}
	}
	if ann, present := decl["annotations"]; present && ann != nil {
		if _, ok := ann.(map[string]any); !ok {
			return fmt.Sprintf("Tool %q: annotations must be an object.", name)
		}
	}
	return ""
}

func cloneMap(m map[string]any) map[string]any {
	cp := make(map[string]any, len(m))
	for k, v := range m {
		cp[k] = v
	}
	return cp
}

func normalizeInput(v any) any {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	if v == nil {
		return map[string]any{}
	}
	return v
}

// callOutcome is what a webview reports back for an `execute`.
type callOutcome struct {
	ok           bool
	result       string
	errorCode    string
	errorMessage string
}

// pendingInvoke is an in-flight MCP tools/call awaiting its executeResult.
type pendingInvoke struct {
	ch chan callOutcome // buffered 1: the completer never blocks
}

// pendingForward is an in-flight executeForward awaiting the owner frame's
// executeResult, to be relayed to the calling frame.
type pendingForward struct {
	callerFrameID string
	requestID     string
}

// ToolRegistry tracks registered tools and in-flight invocations. Safe for
// concurrent use.
type ToolRegistry struct {
	mu            sync.Mutex
	tools         map[string]*toolEntry
	pending       map[string]*pendingInvoke // invocationID -> call
	forwards      map[string]*pendingForward
	frameOrigins  map[string]string
	frameSessions map[string]string
	seq           int
	send          sendFunc
	timeout       time.Duration
}

func newRegistry(send sendFunc) *ToolRegistry {
	return &ToolRegistry{
		tools:         map[string]*toolEntry{},
		pending:       map[string]*pendingInvoke{},
		forwards:      map[string]*pendingForward{},
		frameOrigins:  map[string]string{},
		frameSessions: map[string]string{},
		send:          send,
		timeout:       defaultInvocationTimeout,
	}
}

// setTimeout overrides the per-invocation timeout (used by tests).
func (r *ToolRegistry) setTimeout(d time.Duration) {
	r.mu.Lock()
	r.timeout = d
	r.mu.Unlock()
}

// SetFrameOrigin stamps the origin for a frame (host obligation #2 in
// docs/protocol.md). Later registrations from that frame pick it up.
func (r *ToolRegistry) SetFrameOrigin(frameID, origin string) {
	r.mu.Lock()
	r.frameOrigins[frameID] = origin
	r.mu.Unlock()
}

// list returns all tools sorted by name.
func (r *ToolRegistry) list() []*toolEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	names := make([]string, 0, len(r.tools))
	for n := range r.tools {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]*toolEntry, 0, len(names))
	for _, n := range names {
		out = append(out, r.tools[n])
	}
	return out
}

// get returns a snapshot pointer for a tool, or nil.
func (r *ToolRegistry) get(name string) *toolEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tools[name]
}

func (r *ToolRegistry) sendRegisterResult(frameID, invocationID string, ok bool, errMsg string) {
	msg := map[string]any{"kind": "registerResult", "invocationId": invocationID, "ok": ok}
	if !ok {
		msg["errorMessage"] = errMsg
	}
	r.send(frameID, msg)
}

// handleRegister processes a `register` message. It always replies with a
// registerResult to the frame and returns the outcome.
//
// Stale-frame pruning: a register carrying a NEW `_session` token (the
// embedded bootstrap generates one per page load) first removes every tool
// still owned by that frame — Wails page reloads never deliver FrameGone, so
// this is the reload-recovery path. Without a session token, a same-frame
// re-register of an existing name is treated as an in-place refresh.
func (r *ToolRegistry) handleRegister(frameID, invocationID string, decl map[string]any, exposedTo []string, session string) (bool, string) {
	r.mu.Lock()
	if session != "" && r.frameSessions[frameID] != session {
		for name, t := range r.tools {
			if t.frameID == frameID {
				delete(r.tools, name)
			}
		}
	}
	if errMsg := validateDeclaration(decl); errMsg != "" {
		r.mu.Unlock()
		r.sendRegisterResult(frameID, invocationID, false, errMsg)
		return false, errMsg
	}
	name, _ := decl["name"].(string)
	var errMsg string
	if existing, ok := r.tools[name]; ok {
		switch {
		case existing.frameID != frameID:
			errMsg = fmt.Sprintf("Tool name %q is already used by another webview (frame %q). Tool names must be unique within the app.", name, existing.frameID)
		case session != "":
			// Same page session double-registering: reject so the page can
			// roll back (mirrors the TS registry semantics).
			errMsg = fmt.Sprintf("Tool %q is already registered in this frame.", name)
		}
	}
	if errMsg != "" {
		r.mu.Unlock()
		r.sendRegisterResult(frameID, invocationID, false, errMsg)
		return false, errMsg
	}
	et := exposedTo
	if len(et) == 0 {
		et = nil
	}
	r.tools[name] = &toolEntry{
		decl:      cloneMap(decl),
		name:      name,
		origin:    r.frameOrigins[frameID],
		frameID:   frameID,
		exposedTo: et,
	}
	if session != "" {
		r.frameSessions[frameID] = session
	}
	r.mu.Unlock()
	r.sendRegisterResult(frameID, invocationID, true, "")
	return true, ""
}

// handleUnregister processes an `unregister` message (owner must match).
func (r *ToolRegistry) handleUnregister(frameID, name string) {
	r.mu.Lock()
	if existing, ok := r.tools[name]; ok && existing.frameID == frameID {
		delete(r.tools, name)
	}
	r.mu.Unlock()
}

// removeTool handles the reserved `toolRemoved` notice: drop the named tool
// only if the notifying frame owns it.
func (r *ToolRegistry) removeTool(name, frameID string) {
	r.mu.Lock()
	if existing, ok := r.tools[name]; ok && existing.frameID == frameID {
		delete(r.tools, name)
	}
	r.mu.Unlock()
}

// removeFrame drops every tool owned by a frame (wails window closed).
func (r *ToolRegistry) removeFrame(frameID string) {
	r.mu.Lock()
	for name, t := range r.tools {
		if t.frameID == frameID {
			delete(r.tools, name)
		}
	}
	delete(r.frameOrigins, frameID)
	delete(r.frameSessions, frameID)
	r.mu.Unlock()
}

// invoke routes a tools/call to the owning frame and blocks until the frame
// answers, the timeout fires, or done closes (MCP client went away → abort).
func (r *ToolRegistry) invoke(name string, input any, done <-chan struct{}) (string, error) {
	r.mu.Lock()
	t, ok := r.tools[name]
	if !ok {
		r.mu.Unlock()
		return "", fmt.Errorf("Unknown tool %q. It may have been unregistered by the app.", name)
	}
	r.seq++
	invID := fmt.Sprintf("inv-%s-%d", t.frameID, r.seq)
	p := &pendingInvoke{ch: make(chan callOutcome, 1)}
	r.pending[invID] = p
	frameID := t.frameID
	timeout := r.timeout
	execute := map[string]any{"kind": "execute", "invocationId": invID, "name": name, "input": normalizeInput(input)}
	r.mu.Unlock()

	r.send(frameID, execute)

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case out := <-p.ch:
		if out.ok {
			if out.result == "" {
				return "null", nil
			}
			return out.result, nil
		}
		msg := out.errorMessage
		if msg == "" {
			msg = out.errorCode
		}
		if msg == "" {
			msg = "Tool execution failed."
		}
		return "", errors.New(msg)
	case <-timer.C:
		r.mu.Lock()
		if r.pending[invID] == p {
			delete(r.pending, invID)
		}
		r.mu.Unlock()
		return "", fmt.Errorf("Tool %q timed out after %s (no response from the app webview).", name, timeout)
	case <-done:
		r.mu.Lock()
		if r.pending[invID] == p {
			delete(r.pending, invID)
		}
		r.mu.Unlock()
		r.send(frameID, map[string]any{"kind": "abort", "invocationId": invID})
		return "", fmt.Errorf("Tool %q invocation was cancelled.", name)
	}
}

// handleExecuteResult processes an `executeResult` from a frame: completes an
// MCP tools/call, or relays to the forward caller as executeForwardResult.
func (r *ToolRegistry) handleExecuteResult(invocationID string, ok bool, result, errorCode, errorMessage string) {
	r.mu.Lock()
	if p, found := r.pending[invocationID]; found {
		delete(r.pending, invocationID)
		r.mu.Unlock()
		p.ch <- callOutcome{ok: ok, result: result, errorCode: errorCode, errorMessage: errorMessage}
		return
	}
	if f, found := r.forwards[invocationID]; found {
		delete(r.forwards, invocationID)
		caller, requestID := f.callerFrameID, f.requestID
		r.mu.Unlock()
		msg := map[string]any{"kind": "executeForwardResult", "requestId": requestID, "ok": ok}
		if ok {
			if result == "" {
				result = "null"
			}
			msg["result"] = result
		} else {
			if errorCode != "" {
				msg["errorCode"] = errorCode
			}
			if errorMessage != "" {
				msg["errorMessage"] = errorMessage
			}
		}
		r.send(caller, msg)
		return
	}
	r.mu.Unlock()
	// Unknown invocation (late reply after timeout): ignore.
}

// handleExecuteForward processes `executeForward`: an in-page agent in one
// frame invoking another frame's tool. Enforces exposedTo, routes to the
// owner, and relays the outcome as executeForwardResult to the caller.
func (r *ToolRegistry) handleExecuteForward(callerFrameID, requestID, name string, input any, fromOrigin string) {
	fail := func(code, errMsg string) {
		r.send(callerFrameID, map[string]any{
			"kind": "executeForwardResult", "requestId": requestID, "ok": false,
			"errorCode": code, "errorMessage": errMsg,
		})
	}
	r.mu.Lock()
	t, ok := r.tools[name]
	if !ok {
		r.mu.Unlock()
		fail("NotFoundError", fmt.Sprintf("Tool %q is not registered.", name))
		return
	}
	if t.frameID == callerFrameID {
		r.mu.Unlock()
		fail("InvalidStateError", fmt.Sprintf("Tool %q belongs to the calling frame.", name))
		return
	}
	if !isExposedTo(t, fromOrigin) {
		r.mu.Unlock()
		fail("SecurityError", fmt.Sprintf("Tool %q is not exposed to origin %q.", name, fromOrigin))
		return
	}
	r.seq++
	invID := fmt.Sprintf("fwd-%s-%d", t.frameID, r.seq)
	owner := t.frameID
	r.forwards[invID] = &pendingForward{callerFrameID: callerFrameID, requestID: requestID}
	timeout := r.timeout
	r.mu.Unlock()

	time.AfterFunc(timeout, func() {
		r.mu.Lock()
		if _, still := r.forwards[invID]; !still {
			r.mu.Unlock()
			return
		}
		delete(r.forwards, invID)
		r.mu.Unlock()
		fail("TimeoutError", fmt.Sprintf("Forwarded call to %q timed out.", name))
	})

	r.send(owner, map[string]any{"kind": "execute", "invocationId": invID, "name": name, "input": normalizeInput(input)})
}

// handleGetToolsRequest aggregates the registry for an in-page agent:
// the caller's own tools are always visible; foreign tools must pass the
// fromOrigins filter (when provided) and be exposed to forOrigin.
func (r *ToolRegistry) handleGetToolsRequest(frameID, requestID, forOrigin string, fromOrigins []string) {
	tools := r.list()
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		if t.frameID != frameID {
			if len(fromOrigins) > 0 && !containsString(fromOrigins, t.origin) {
				continue
			}
			if !isExposedTo(t, forOrigin) {
				continue
			}
		}
		out = append(out, t.info())
	}
	r.send(frameID, map[string]any{"kind": "getToolsResponse", "requestId": requestID, "tools": out})
}
