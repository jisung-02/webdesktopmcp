package webdesktopmcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAppRegistryFileLifecycle(t *testing.T) {
	dir := t.TempDir()
	s, err := New(Config{AppName: "LifecycleApp", AppVersion: "9.9.9", RegistryDir: dir})
	if err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dir, "registry.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("registry.json missing after New: %v", err)
	}
	if fi, err := os.Stat(path); err != nil {
		t.Fatal(err)
	} else if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Fatalf("perm = %v, want 0600", fi.Mode().Perm())
	}

	var entry struct {
		Apps map[string]struct {
			AppName         string `json:"appName"`
			URL             string `json:"url"`
			Token           string `json:"token"`
			PID             int    `json:"pid"`
			ProtocolVersion int    `json:"protocolVersion"`
			UpdatedAt       string `json:"updatedAt"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		t.Fatalf("registry.json is not valid JSON: %v", err)
	}
	info, ok := entry.Apps["LifecycleApp"]
	if !ok {
		t.Fatalf("entry missing: %s", raw)
	}
	if info.URL != s.URL() {
		t.Fatalf("url = %q, want %q", info.URL, s.URL())
	}
	if info.Token != s.Token() || info.Token == "" {
		t.Fatalf("token mismatch: %q", info.Token)
	}
	if info.PID != os.Getpid() {
		t.Fatalf("pid = %d", info.PID)
	}
	if info.ProtocolVersion != ProtocolVersion {
		t.Fatalf("protocolVersion = %d", info.ProtocolVersion)
	}
	if info.UpdatedAt == "" {
		t.Fatal("updatedAt missing")
	}

	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	raw, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var after struct {
		Apps map[string]json.RawMessage `json:"apps"`
	}
	if err := json.Unmarshal(raw, &after); err != nil {
		t.Fatal(err)
	}
	if _, still := after.Apps["LifecycleApp"]; still {
		t.Fatalf("entry not removed on Close: %s", raw)
	}
}

func TestAppRegistryKeepsOtherApps(t *testing.T) {
	dir := t.TempDir()
	a, err := New(Config{AppName: "AppA", RegistryDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	b, err := New(Config{AppName: "AppB", RegistryDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()

	if err := a.Close(); err != nil {
		t.Fatalf("Close AppA: %v", err)
	}
	reg := readAppRegistry(filepath.Join(dir, "registry.json"))
	if _, ok := reg.Apps["AppA"]; ok {
		t.Fatal("AppA entry still present")
	}
	entry, ok := reg.Apps["AppB"]
	if !ok || entry.URL != b.URL() || entry.Token != b.Token() {
		t.Fatalf("AppB entry wrong: %+v", reg.Apps)
	}
}

func TestAppRegistryRecoversFromCorruptFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "registry.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{AppName: "ResilientApp", RegistryDir: dir})
	if err != nil {
		t.Fatalf("New with corrupt registry file: %v", err)
	}
	defer s.Close()
	reg := readAppRegistry(filepath.Join(dir, "registry.json"))
	if _, ok := reg.Apps["ResilientApp"]; !ok {
		t.Fatal("entry missing after recovery")
	}
}
