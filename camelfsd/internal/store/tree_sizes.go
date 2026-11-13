package store

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// Size sidecars retain Git's tree bytes and id. Like blob size metadata, sizes
// are written by the daemon, never accepted as an API caller's assertion.
func verifyTreeSizes(id string, b []byte) error {
	var es []struct {
		Path, Mode, SHA1 string
		Size             int64
	}
	if e := json.Unmarshal(b, &es); e != nil {
		return e
	}
	var tree bytes.Buffer
	for _, e := range es {
		raw, err := hex.DecodeString(e.SHA1)
		if err != nil || len(raw) != 20 || e.Size < 0 {
			return fmt.Errorf("invalid tree sizes")
		}
		fmt.Fprintf(&tree, "%s %s\x00", e.Mode, e.Path)
		tree.Write(raw)
	}
	if GitHash("tree", tree.Bytes()) != id {
		return fmt.Errorf("tree sizes hash mismatch")
	}
	return nil
}
