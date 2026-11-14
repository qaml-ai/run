package image

import (
	"strings"
	"testing"
)

func TestMissingTargets(t *testing.T) {
	full := "snapshot-merge   v1.5.0\nsnapshot-origin  v1.9.0\nsnapshot         v1.16.0\nlinear           v1.4.0\nstriped          v1.6.0\nerror            v1.6.0\n"
	if err := missingTargets(full); err != nil {
		t.Fatal(err)
	}
	// Without dm-snapshot loaded only the built-in targets are listed.
	err := missingTargets("linear           v1.4.0\nstriped          v1.6.0\nerror            v1.6.0\n")
	if err == nil || !strings.Contains(err.Error(), "target(s) snapshot missing") {
		t.Fatalf("missing snapshot not refused: %v", err)
	}
	// snapshot-origin alone (a prefix match) is not the snapshot target.
	if err := missingTargets("snapshot-origin v1.9.0\nlinear v1.4.0\n"); err == nil {
		t.Fatal("snapshot-origin accepted as snapshot")
	}
}
