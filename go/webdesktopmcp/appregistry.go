// App registry file (~/.webdesktopmcp/registry.json): how `webdesktopmcp
// connect` and other local tools discover running desktop apps. Same JSON
// shape as docs/protocol.md section 7 / packages/server/src/registry-file.ts,
// so one CLI works across Electron/Tauri/Wails hosts. Written atomically
// (tmp + rename) with mode 0600 because it contains the bearer token.

package webdesktopmcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
)

const appRegistryFileName = "registry.json"

// appRegistryMu serializes read-modify-write cycles across Server instances
// in this process (multiple apps or windows sharing a RegistryDir).
var appRegistryMu sync.Mutex

type appRegistryEntry struct {
	AppName         string `json:"appName"`
	URL             string `json:"url"`
	Token           string `json:"token"`
	PID             int    `json:"pid"`
	ProtocolVersion int    `json:"protocolVersion"`
	UpdatedAt       string `json:"updatedAt"`
}

type appRegistryFile struct {
	Apps map[string]appRegistryEntry `json:"apps"`
}

func defaultRegistryDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return appRegistryFileName
	}
	return filepath.Join(home, ".webdesktopmcp")
}

// upsertAppEntry inserts or refreshes this app's entry (call at server start).
func upsertAppEntry(dir string, entry appRegistryEntry) error {
	appRegistryMu.Lock()
	defer appRegistryMu.Unlock()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, appRegistryFileName)
	reg := readAppRegistry(path)
	// Best-effort cleanup: drop entries whose owning process is gone.
	for name, existing := range reg.Apps {
		if name != entry.AppName && existing.PID != 0 && existing.PID != os.Getpid() && !processAlive(existing.PID) {
			delete(reg.Apps, name)
		}
	}
	entry.ProtocolVersion = ProtocolVersion
	entry.UpdatedAt = nowRFC3339Milli()
	reg.Apps[entry.AppName] = entry
	return writeAppRegistryAtomic(path, reg)
}

// removeAppEntry removes this app's entry (call on graceful shutdown).
func removeAppEntry(dir, appName string) error {
	appRegistryMu.Lock()
	defer appRegistryMu.Unlock()
	path := filepath.Join(dir, appRegistryFileName)
	reg := readAppRegistry(path)
	if _, ok := reg.Apps[appName]; !ok {
		return nil
	}
	delete(reg.Apps, appName)
	return writeAppRegistryAtomic(path, reg)
}

func readAppRegistry(path string) appRegistryFile {
	reg := appRegistryFile{Apps: map[string]appRegistryEntry{}}
	data, err := os.ReadFile(path)
	if err != nil {
		return reg
	}
	_ = json.Unmarshal(data, &reg)
	if reg.Apps == nil {
		reg.Apps = map[string]appRegistryEntry{}
	}
	return reg
}

// writeAppRegistryAtomic writes tmp+rename so readers never see a torn file.
func writeAppRegistryAtomic(path string, reg appRegistryFile) error {
	data, err := json.MarshalIndent(reg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once rename succeeds
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// processAlive probes a PID with signal 0 (unix only; on Windows we keep
// entries rather than misclassify live apps).
func processAlive(pid int) bool {
	if pid <= 0 || pid == os.Getpid() {
		return true
	}
	if runtime.GOOS == "windows" {
		return true
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// nowRFC3339Milli matches the TS reference (new Date().toISOString()).
func nowRFC3339Milli() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
