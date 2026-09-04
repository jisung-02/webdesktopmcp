// Loopback MCP server: exposes the app's webview-registered WebMCP tools to
// external MCP clients as stateless JSON over HTTP (mirror of
// packages/server/src/server.ts, minus the MCP SDK — the JSON-RPC envelope is
// implemented directly so page-declared inputSchemas pass through verbatim).

package webdesktopmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const maxBodyBytes = 10 << 20 // 10 MiB is plenty for JSON-RPC tool calls

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`

	// invalid marks an element that could not be decoded (batch only); it
	// must still yield a -32600 response instead of being treated as a
	// notification.
	invalid bool `json:"-"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func errorResponse(id json.RawMessage, code int, msg string) *rpcResponse {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	return &rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}}
}

func toolErrorResult(msg string) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": msg}},
		"isError": true,
	}
}

// ---------------------------------------------------------------------------
// HTTP entry point (*Server is an http.Handler for the MCP endpoint)
// ---------------------------------------------------------------------------

// ServeHTTP implements the /mcp endpoint: 127.0.0.1-only binding is enforced
// by the listener; bearer-token auth guards everything except the unauthenticated
// health probe. Stateless JSON mode: POST JSON-RPC, no SSE, no sessions.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/mcp" {
		http.NotFound(w, r)
		return
	}

	// Unauthenticated health probe so launchers/CLIs can detect a live app.
	if r.Method == http.MethodGet && r.URL.Query().Get("health") == "1" {
		writeJSON(w, http.StatusOK, map[string]any{
			"app":             s.appName,
			"version":         s.appVersion,
			"protocolVersion": ProtocolVersion,
		})
		return
	}

	if !s.authOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": "Unauthorized. Pass the bearer token from the app's registry entry.",
		})
		return
	}

	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST JSON-RPC to /mcp."})
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil || len(body) > maxBodyBytes {
		writeJSON(w, http.StatusBadRequest, errorResponse(nil, -32700, "Unable to read request body"))
		return
	}
	s.serveRPC(w, r, body)
}

// authOK compares the Authorization header in constant time.
func (s *Server) authOK(r *http.Request) bool {
	got := r.Header.Get("Authorization")
	want := "Bearer " + s.token
	return subtleCompare(got, want)
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

func (s *Server) serveRPC(w http.ResponseWriter, r *http.Request, body []byte) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		writeJSON(w, http.StatusBadRequest, errorResponse(nil, -32700, "Parse error"))
		return
	}

	batch := trimmed[0] == '['
	var rawReqs []json.RawMessage
	if batch {
		if err := json.Unmarshal(trimmed, &rawReqs); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse(nil, -32600, "Invalid Request"))
			return
		}
		if len(rawReqs) == 0 {
			writeJSON(w, http.StatusBadRequest, errorResponse(nil, -32600, "Invalid Request: empty batch"))
			return
		}
	} else {
		rawReqs = []json.RawMessage{trimmed}
	}

	reqs := make([]rpcRequest, 0, len(rawReqs))
	for _, raw := range rawReqs {
		var req rpcRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			// Undecodable element inside a batch → per-element invalid request.
			reqs = append(reqs, rpcRequest{invalid: true})
			continue
		}
		reqs = append(reqs, req)
	}

	notificationsOnly := true
	responses := make([]json.RawMessage, 0, len(reqs))
	for i := range reqs {
		req := &reqs[i]
		isNotification := !req.invalid && (len(req.ID) == 0 || string(req.ID) == "null")
		if !isNotification {
			notificationsOnly = false
		}
		resp := s.handleRPC(r.Context(), req)
		if resp == nil {
			continue // notification: no response body
		}
		encoded, err := json.Marshal(resp)
		if err != nil {
			encoded, _ = json.Marshal(errorResponse(req.ID, -32603, "Internal error"))
		}
		responses = append(responses, encoded)
	}

	if notificationsOnly {
		// Notifications receive an empty 202 (MCP stateless HTTP convention).
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if batch {
		writeRawJSON(w, http.StatusOK, responses)
		return
	}
	if len(responses) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(responses[0])
}

// handleRPC dispatches one JSON-RPC request. Returns nil for notifications
// (requests without an id), which receive an empty 202.
func (s *Server) handleRPC(ctx context.Context, req *rpcRequest) *rpcResponse {
	if req.invalid {
		return errorResponse(json.RawMessage("null"), -32600, "Invalid Request")
	}
	if len(req.ID) == 0 || string(req.ID) == "null" {
		return nil
	}
	switch {
	case req.Method == "":
		return errorResponse(req.ID, -32600, "Invalid Request")
	case req.Method == "initialize":
		return &rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: s.initializeResult(req.Params)}
	case req.Method == "tools/list":
		return &rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: s.toolsList()}
	case req.Method == "tools/call":
		return &rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: s.toolsCall(ctx, req.Params)}
	case req.Method == "ping":
		return &rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}}
	case strings.HasPrefix(req.Method, "notifications/"):
		// e.g. notifications/initialized — accepted, no response.
		return nil
	default:
		return errorResponse(req.ID, -32601, fmt.Sprintf("Method not found: %s", req.Method))
	}
}

// initializeResult answers `initialize`; the client's protocolVersion is
// echoed so strict clients proceed (this endpoint is a plain JSON-RPC subset
// of Streamable-HTTP MCP).
func (s *Server) initializeResult(params json.RawMessage) map[string]any {
	var p struct {
		ProtocolVersion any `json:"protocolVersion"`
	}
	if len(params) > 0 {
		_ = json.Unmarshal(params, &p)
	}
	version := "2025-06-18"
	if v, ok := p.ProtocolVersion.(string); ok && v != "" {
		version = v
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]any{"name": s.appName, "version": s.appVersion},
	}
}

// toolsList renders externally visible tools in MCP shape. Tools with a
// non-empty exposedTo are reserved for in-page agents and hidden.
func (s *Server) toolsList() map[string]any {
	tools := make([]map[string]any, 0)
	for _, t := range s.reg.list() {
		if len(t.exposedTo) > 0 {
			continue
		}
		m := map[string]any{
			"name":        t.name,
			"description": t.decl["description"],
			"inputSchema": schemaOf(t),
			"_meta": map[string]any{
				"webdesktopmcp/frameId": t.frameID,
				"webdesktopmcp/origin":  t.origin,
			},
		}
		if title, ok := t.decl["title"].(string); ok && title != "" {
			m["title"] = title
		}
		if ann, ok := t.decl["annotations"].(map[string]any); ok {
			a := map[string]any{}
			if ro, ok := ann["readOnlyHint"].(bool); ok {
				a["readOnlyHint"] = ro
			}
			if len(a) > 0 {
				m["annotations"] = a
			}
		}
		tools = append(tools, m)
	}
	return map[string]any{"tools": tools}
}

// schemaOf passes the page-declared inputSchema through verbatim, falling
// back to an empty object schema (mirrors the TS server).
func schemaOf(t *toolEntry) any {
	if schema, ok := t.decl["inputSchema"].(map[string]any); ok && schema != nil {
		return schema
	}
	return map[string]any{"type": "object", "properties": map[string]any{}}
}

// toolsCall implements tools/call: confirm hook → route `execute` to the
// owning webview → await executeResult (120s) → text content (+ structured
// content when the result is valid JSON).
func (s *Server) toolsCall(ctx context.Context, params json.RawMessage) any {
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Name == "" {
		return toolErrorResult(`Invalid params: "name" is required.`)
	}

	tool := s.reg.get(p.Name)
	if tool == nil {
		return toolErrorResult(fmt.Sprintf("Unknown tool %q. It may have been unregistered by the app.", p.Name))
	}

	// Exposure is enforced on calls, not just listings (parity with the TS
	// reference server): exposedTo tools are reserved for in-page agents.
	if len(tool.exposedTo) > 0 {
		return toolErrorResult(fmt.Sprintf("Tool %q is reserved for in-page agents (exposedTo) and is not callable by external clients.", p.Name))
	}

	input := p.Arguments
	if input == nil {
		input = map[string]any{}
	}
	if hook := s.getConfirm(); hook != nil {
		allowed, err := runConfirm(hook, p.Name, input)
		if err != nil {
			return toolErrorResult(fmt.Sprintf("Confirmation failed: %v", err))
		}
		if !allowed {
			return toolErrorResult("The user declined this tool call.")
		}
	}

	result, err := s.reg.invoke(p.Name, input, ctx.Done())
	if err != nil {
		return toolErrorResult(err.Error())
	}
	out := map[string]any{
		"content": []any{map[string]any{"type": "text", "text": result}},
	}
	if structured, ok := safeParseJSON(result); ok {
		out["structuredContent"] = structured
	}
	return out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeRawJSON(w http.ResponseWriter, status int, bodies []json.RawMessage) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte("["))
	for i, b := range bodies {
		if i > 0 {
			_, _ = w.Write([]byte(","))
		}
		_, _ = w.Write(b)
	}
	_, _ = w.Write([]byte("]"))
}

// runConfirm invokes the native-confirm gate, converting panics into errors.
func runConfirm(hook func(toolName string, input map[string]any) bool, name string, input map[string]any) (allowed bool, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			allowed, err = false, fmt.Errorf("%v", rec)
		}
	}()
	return hook(name, input), nil
}

func safeParseJSON(s string) (any, bool) {
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return nil, false
	}
	return v, true
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "?"
	}
	return string(b)
}
