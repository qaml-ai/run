package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadAPITokenFormats(t *testing.T) {
	for _, tc := range []struct {
		name, raw, want string
		bad             bool
	}{
		{"raw", " \nraw-bearer-token\r\n ", "raw-bearer-token", false},
		{"raw hex", "deadbeef\n", "deadbeef", false},
		{"env", "# jobhost configuration\nOTHER=value\n CAMELFS_API_TOKEN = deadBEEF \r\n", "deadBEEF", false},
		{"empty", " \r\n\t", "", true},
		{"empty env", "CAMELFS_API_TOKEN= \nOTHER=value\n", "", true},
		{"non hex env", "CAMELFS_API_TOKEN=not-a-hex-token\n", "", true},
		{"odd hex env", "CAMELFS_API_TOKEN=abc\n", "", true},
		{"duplicate", "CAMELFS_API_TOKEN=deadbeef\nCAMELFS_API_TOKEN=abcdef00\n", "", true},
		{"missing env key", "# configuration\nOTHER=value\n", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "camelfs-api.env")
			if e := os.WriteFile(path, []byte(tc.raw), 0600); e != nil {
				t.Fatal(e)
			}
			got, e := readAPIToken(path)
			if tc.bad {
				if e == nil || got != "" {
					t.Fatal("invalid token file accepted")
				}
				if strings.Contains(e.Error(), "not-a-hex-token") {
					t.Fatal("error exposed token contents")
				}
			} else if e != nil || got != tc.want {
				t.Fatal("token file did not parse as expected", e)
			}
		})
	}
	if _, e := readAPIToken(filepath.Join(t.TempDir(), "missing")); e == nil {
		t.Fatal("missing token file accepted")
	}
}
