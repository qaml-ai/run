//go:build !guest

package main

import (
	"bytes"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUnitNotifyKeySources(t *testing.T) {
	const name = "CAMELFS_NOTIFY_KEY"
	key := bytes.Repeat([]byte{0xab}, 32)
	path := filepath.Join(t.TempDir(), "notify")
	if err := os.WriteFile(path, key, 0600); err != nil {
		t.Fatal(err)
	}
	shortPath := filepath.Join(t.TempDir(), "short")
	if err := os.WriteFile(shortPath, key[:31], 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, path, env, wantErr string
		envSet                   bool
	}{
		{"file", path, "", "", false},
		{"env", "", hex.EncodeToString(key), "", true},
		{"both", path, hex.EncodeToString(key), "exactly one", true},
		{"neither", "", "", "exactly one", false},
		{"empty env is set", path, "", "exactly one", true},
		{"bad hex", "", "invalid", "must be hex", true},
		{"short env", "", hex.EncodeToString(key[:31]), "at least 32", true},
		{"short file", shortPath, "", "at least 32", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(name, tc.env)
			if !tc.envSet {
				if err := os.Unsetenv(name); err != nil {
					t.Fatal(err)
				}
			}
			got, err := loadNotifyKey(tc.path)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("want %q, got %v", tc.wantErr, err)
				}
				return
			}
			if err != nil || !bytes.Equal(got, key) {
				t.Fatalf("unexpected key result: %v", err)
			}
		})
	}
}
