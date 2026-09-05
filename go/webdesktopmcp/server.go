// Package webdesktopmcp lets Wails v2 desktop apps expose the WebMCP tools
// registered by their webviews to external MCP clients (Claude Desktop,
// Cursor, ...) over a loopback-only, bearer-token-guarded Streamable-HTTP
// endpoint. It implements docs/protocol.md natively in Go with zero
// third-party dependencies and does not import Wails itself.
//
// Typical Wails v2 integration:
//
//	mcp, err := webdesktopmcp.New(webdesktopmcp.Config{
//		AppName: "MyApp", AppVersion: "1.0.0",
//	})
//	if err != nil { log.Fatal(err) }
//	defer mcp.Close()
//
//	// 1. Deliver host→page messages (broadcast is fine; each page filters).
//	mcp.SetEventEmitter(func(event string, data ...interface{}) {
//		runtime.EventsEmit(ctx, event, data...)
//	})
//
//	// 2. Bind the server so the page can send messages:
//	//    window.go.webdesktopmcp.Server.Send(frameId, msg)
//	// 3. Serve/inject mcp.InitScript() (also at GET /webdesktopmcp.js via
//	//    mcp.Handler()) into every window's main world.
//	// 4. Call mcp.FrameGone(windowName) when a window closes.
//
// Deviations from docs/protocol.md and the TS reference are documented on the
// relevant symbols (stale-frame session pruning and trusted frame provenance).
package webdesktopmcp

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

// Config configures a webdesktopmcp server.
type Config struct {
	// AppName is required: it names the app's entry in ~/.webdesktopmcp/registry.json.
	AppName string
	// AppVersion is reported by MCP `initialize` (default "0.0.0").
	AppVersion string
	// Port to bind on 127.0.0.1. 0 (default) picks an ephemeral port.
	Port int
	// RegistryDir overrides the app-registry directory (default
	// ~/.webdesktopmcp). Useful for tests.
	RegistryDir string
}

// Server is the webdesktopmcp host for one Wails app. Create with New; bind
// it into wails options.Bind and wire SetEventEmitter/InitScript. Safe for
// concurrent use.
type Server struct {
	appName    string
	appVersion string
	token      string
	port       int
	dir        string

	httpServer *http.Server
	reg        *ToolRegistry

	mu      sync.RWMutex
	emitter func(event string, data ...interface{})
	confirm func(toolName string, input map[string]any) bool

	closeOnce sync.Once
	closeErr  error
}

// New validates the config, binds the loopback MCP endpoint, and upserts the
// app's entry in the shared registry file (~/.webdesktopmcp/registry.json).
func New(cfg Config) (*Server, error) {
	if cfg.AppName == "" {
		return nil, fmt.Errorf("webdesktopmcp: Config.AppName is required (it keys the app's registry.json entry)")
	}
	version := cfg.AppVersion
	if version == "" {
		version = "0.0.0"
	}
	token, err := newToken()
	if err != nil {
		return nil, fmt.Errorf("webdesktopmcp: generating bearer token: %w", err)
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.Port))
	if err != nil {
		return nil, fmt.Errorf("webdesktopmcp: binding MCP endpoint on 127.0.0.1:%d: %w", cfg.Port, err)
	}

	dir := cfg.RegistryDir
	if dir == "" {
		dir = defaultRegistryDir()
	}

	s := &Server{
		appName:    cfg.AppName,
		appVersion: version,
		token:      token,
		port:       ln.Addr().(*net.TCPAddr).Port,
		dir:        dir,
		emitter:    func(string, ...interface{}) {}, // default: messages are dropped
	}
	s.reg = newRegistry(s.sendToFrame)

	s.httpServer = &http.Server{
		Handler:           s.rootHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() { _ = s.httpServer.Serve(ln) }()

	if err := upsertAppEntry(dir, appRegistryEntry{
		AppName: cfg.AppName,
		URL:     s.URL(),
		Token:   token,
		PID:     os.Getpid(),
	}); err != nil {
		_ = s.httpServer.Close()
		_ = ln.Close()
		return nil, fmt.Errorf("webdesktopmcp: writing app registry: %w", err)
	}
	return s, nil
}

// URL is the MCP endpoint (http://127.0.0.1:<port>/mcp).
func (s *Server) URL() string { return fmt.Sprintf("http://127.0.0.1:%d/mcp", s.port) }

// Token is the bearer token required by the endpoint (also stored in the
// app's registry.json entry for CLI shims).
func (s *Server) Token() string { return s.token }

// Port is the bound loopback port.
func (s *Server) Port() int { return s.port }

// Close stops the HTTP server and removes the app's registry.json entry.
// Idempotent; returns the registry-removal error, if any.
func (s *Server) Close() error {
	s.closeOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = s.httpServer.Shutdown(ctx)
		_ = s.httpServer.Close()
		s.closeErr = removeAppEntry(s.dir, s.appName)
	})
	return s.closeErr
}

// Handler returns an http.Handler suitable for wails AssetServer.Handler:
// it serves the bootstrap script at GET /webdesktopmcp.js and delegates
// everything else to the MCP endpoint.
func (s *Server) Handler() http.Handler { return s.rootHandler() }

func (s *Server) rootHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/webdesktopmcp.js", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(bootstrapScript))
	})
	mux.Handle("/", s) // *Server.ServeHTTP handles /mcp
	return mux
}

// InitScript returns the bootstrap JavaScript to inject into every window's
// main world (ES2020; also served at GET /webdesktopmcp.js).
func (s *Server) InitScript() string { return bootstrapScript }

// SetEventEmitter wires host→page delivery. The dev implementation should
// forward to wails runtime.EventsEmit(ctx, event, data...) — Wails broadcasts
// to every window; each page's bootstrap filters messages it does not own.
func (s *Server) SetEventEmitter(emit func(event string, data ...interface{})) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if emit == nil {
		emit = func(string, ...interface{}) {}
	}
	s.emitter = emit
}

// SetConfirmHook installs an optional native-confirm gate: before an MCP
// tools/call executes, hook(toolName, input) is called; returning false
// declines the call. Panics inside the hook are converted to error results.
func (s *Server) SetConfirmHook(hook func(toolName string, input map[string]any) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.confirm = hook
}

func (s *Server) getConfirm() func(toolName string, input map[string]any) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.confirm
}

// SetFrameOrigin sets trusted host provenance. Renderer-provided origins are ignored.
// Wails bindings do not authenticate frameID: bind Send only for trusted pages,
// or route through a native wrapper that supplies an authenticated frame ID.
// Frames with unknown origins cannot access tools owned by other frames.
func (s *Server) SetFrameOrigin(frameID, origin string) {
	s.reg.SetFrameOrigin(frameID, origin)
}

// FrameGone removes every tool owned by a frame. Call it from wails window
// close hooks (e.g. window Closing/Closed events).
func (s *Server) FrameGone(frameID string) {
	s.reg.removeFrame(frameID)
}

// sendToFrame delivers a host message to the page via the event emitter.
func (s *Server) sendToFrame(frameID string, msg map[string]any) {
	s.mu.RLock()
	emit := s.emitter
	s.mu.RUnlock()
	msg = cloneMap(msg)
	msg["_frameId"] = frameID
	emit("webdesktopmcp:message", msg)
}

// ---------------------------------------------------------------------------
// Send: page → host message dispatch (bound into wails options.Bind)
// ---------------------------------------------------------------------------

// Send handles one RendererMessage from a webview (docs/protocol.md). Wails
// binds it as window.go.webdesktopmcp.Server.Send(frameId, message). The
// returned ack is {"ok": true} / {"ok": false, "error": "..."} for transport-
// level problems only — business outcomes (e.g. register rejection) travel as
// separate registerResult/executeForwardResult messages, so the JS side can
// stay fire-and-forget.
func (s *Server) Send(frameID string, message map[string]any) map[string]any {
	if frameID == "" {
		return ackErr("frameID is required")
	}
	if message == nil {
		return ackErr("message must be an object")
	}
	kind, _ := message["kind"].(string)
	if kind == "" {
		return ackErr(`message "kind" is required`)
	}

	switch kind {
	case "register":
		invocationID, _ := message["invocationId"].(string)
		if invocationID == "" {
			return ackErr(`register requires "invocationId"`)
		}
		tool, _ := message["tool"].(map[string]any) // nil → registerResult(ok:false)
		session, _ := message["_session"].(string)
		s.reg.handleRegister(frameID, invocationID, tool, toStringSlice(message["exposedTo"]), session)
		return ackOK()

	case "unregister":
		name, _ := message["name"].(string)
		s.reg.handleUnregister(frameID, name)
		return ackOK()

	case "executeResult":
		invocationID, _ := message["invocationId"].(string)
		if invocationID == "" {
			return ackErr(`executeResult requires "invocationId"`)
		}
		ok, _ := message["ok"].(bool)
		result, _ := message["result"].(string)
		errorCode, _ := message["errorCode"].(string)
		errorMessage, _ := message["errorMessage"].(string)
		s.reg.handleExecuteResult(frameID, invocationID, ok, result, errorCode, errorMessage)
		return ackOK()

	case "executeForward":
		requestID, _ := message["requestId"].(string)
		name, _ := message["name"].(string)
		if requestID == "" || name == "" {
			return ackErr(`executeForward requires "requestId" and "name"`)
		}
		s.reg.handleExecuteForward(frameID, requestID, name, message["input"])
		return ackOK()

	case "cancelForward":
		requestID, _ := message["requestId"].(string)
		if requestID == "" {
			return ackErr("cancelForward requires requestId")
		}
		s.reg.handleCancelForward(frameID, requestID)
		return ackOK()

	case "getToolsRequest":
		requestID, _ := message["requestId"].(string)
		if requestID == "" {
			return ackErr(`getToolsRequest requires "requestId"`)
		}
		s.reg.handleGetToolsRequest(frameID, requestID, toStringSlice(message["fromOrigins"]))
		return ackOK()

	case "toolRemoved":
		name, _ := message["name"].(string)
		s.reg.removeTool(name, frameID)
		return ackOK()

	case "log":
		level, _ := message["level"].(string)
		msg, _ := message["message"].(string)
		log.Println(fmt.Sprintf("[webdesktopmcp %s] %s", level, msg))
		return ackOK()

	default:
		return ackErr(fmt.Sprintf("unknown message kind %q", kind))
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func ackOK() map[string]any { return map[string]any{"ok": true} }

func ackErr(msg string) map[string]any { return map[string]any{"ok": false, "error": msg} }

func toStringSlice(v any) []string {
	switch list := v.(type) {
	case []string:
		if len(list) == 0 {
			return nil
		}
		return list
	case []any:
		out := make([]string, 0, len(list))
		for _, item := range list {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		if len(out) == 0 {
			return nil
		}
		return out
	default:
		return nil
	}
}

// newToken generates a 192-bit URL-safe bearer token.
func newToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// subtleCompare is a constant-time string comparison.
func subtleCompare(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
