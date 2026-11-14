package store

import (
	"strings"

	"github.com/qaml-ai/run/camelfsd/internal/root"
)

// validReadKey admits the immutable object namespace and the content-addressed guest
// images (guest/<sha256>.json manifests and guest/<sha256>.ext4.zst).
func validReadKey(key string) bool {
	if valid(key) || guestManifest(key) {
		return true
	}
	name, ok := strings.CutPrefix(key, "guest/")
	sha, compressed := strings.CutSuffix(name, ".ext4.zst")
	return ok && compressed && root.Hex(sha, 64)
}
