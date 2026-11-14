//go:build !guest

package main

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestGuestInputs keeps camelfsd/scripts/guest-inputs.txt equal to what the guest binary is built from: CI builds
// and publishes a guest image only when a listed path changes, so a missing input would ship a stale image.
func TestGuestInputs(t *testing.T) {
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join(repo, "camelfsd/scripts/guest-inputs.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var inputs []string
	lines := bufio.NewScanner(f)
	for lines.Scan() {
		line := strings.TrimSpace(lines.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if _, err := os.Stat(filepath.Join(repo, line)); err != nil {
			t.Errorf("guest input %s: %v", line, err)
		}
		inputs = append(inputs, line)
	}
	if err := lines.Err(); err != nil {
		t.Fatal(err)
	}
	covered := func(path string) bool {
		for _, in := range inputs {
			if path == in || strings.HasSuffix(in, "/") && strings.HasPrefix(path, in) {
				return true
			}
		}
		return false
	}
	cmd := exec.Command("go", "list", "-deps", "-tags", "guest", "-f", `{{if not .Standard}}{{.Module.Path}}|{{.Dir}}|{{join .GoFiles " "}}|{{join .EmbedFiles " "}}{{end}}`, ".")
	cmd.Env = append(os.Environ(), "GOOS=linux", "GOARCH=amd64", "CGO_ENABLED=0")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list: %v", err)
	}
	module := "github.com/qaml-ai/run/camelfsd"
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "|", 4)
		if len(parts) != 4 || parts[0] != module {
			continue // the standard library and pinned modules (go.sum) are covered by go.mod/go.sum
		}
		for _, name := range append(strings.Fields(parts[2]), strings.Fields(parts[3])...) {
			rel, err := filepath.Rel(repo, filepath.Join(parts[1], name))
			if err != nil {
				t.Fatal(err)
			}
			if rel = filepath.ToSlash(rel); !covered(rel) {
				t.Errorf("%s is compiled into the guest but missing from camelfsd/scripts/guest-inputs.txt", rel)
			}
		}
	}
}
