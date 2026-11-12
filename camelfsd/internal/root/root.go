package root

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
)

const ChunkSize int64 = 256 << 10

type Root struct {
	V           int               `json:"v"`
	ParentRoot  string            `json:"parentRoot"`
	Tree        string            `json:"tree"`
	VirtualSize int64             `json:"virtualSize"`
	FSType      string            `json:"fsType"`
	Chunks      map[string]string `json:"chunks"`
	Packs       map[string]string `json:"packs,omitempty"`
	PackWindow  int64             `json:"packWindow,omitempty"`
}

func Hex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func Hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func (r Root) Validate() error {
	if r.V != 1 || r.FSType != "ext4" || r.VirtualSize <= 0 || r.VirtualSize%512 != 0 || r.Chunks == nil {
		return fmt.Errorf("invalid root")
	}
	if r.ParentRoot != "" && !Hex(r.ParentRoot, 64) || r.Tree != "" && !Hex(r.Tree, 40) {
		return fmt.Errorf("invalid root id")
	}
	for k, h := range r.Chunks {
		o, e := strconv.ParseInt(k, 10, 64)
		if e != nil || o < 0 || o >= r.VirtualSize || o%ChunkSize != 0 || strconv.FormatInt(o, 10) != k || !Hex(h, 64) {
			return fmt.Errorf("invalid chunk")
		}
	}
	for k, h := range r.Packs {
		o, e := strconv.ParseInt(k, 10, 64)
		w := r.Window()
		if e != nil || o < 0 || o >= r.VirtualSize || o%w != 0 || !Hex(h, 64) || strconv.FormatInt(o, 10) != k {
			return fmt.Errorf("invalid pack")
		}
		if PackID(r.WindowHashes(o)) != h || len(r.WindowHashes(o)) < 2 {
			return fmt.Errorf("invalid pack members")
		}
	}
	if r.PackWindow < 0 || r.Window()%ChunkSize != 0 {
		return fmt.Errorf("invalid pack window")
	}
	return nil
}
func (r Root) Window() int64 {
	if r.PackWindow == 0 {
		return 4 << 20
	}
	return r.PackWindow
}
func (r Root) WindowHashes(o int64) []string {
	var out []string
	for x := o; x < min(o+r.Window(), r.VirtualSize); x += ChunkSize {
		if h := r.Chunks[strconv.FormatInt(x, 10)]; h != "" {
			out = append(out, h)
		}
	}
	return out
}
func PackID(h []string) string {
	var b []byte
	for _, s := range h {
		b = append(b, []byte(s)...)
	}
	return Hash(b)
}

// Marshal a map so every level, including the top level, is lexically sorted.
// v0-limitation: L18
func Encode(r Root) ([]byte, error) {
	if e := r.Validate(); e != nil {
		return nil, e
	}
	m := map[string]any{"v": r.V, "parentRoot": r.ParentRoot, "tree": r.Tree, "virtualSize": r.VirtualSize, "fsType": r.FSType, "chunks": r.Chunks}
	if len(r.Packs) > 0 {
		m["packs"] = r.Packs
		if r.PackWindow != 0 {
			m["packWindow"] = r.PackWindow
		}
	}
	return json.Marshal(m)
}
func Decode(b []byte) (Root, error) {
	var r Root
	e := json.Unmarshal(b, &r)
	if e == nil {
		e = r.Validate()
	}
	return r, e
}
func Diff(a, b Root) []int64 {
	m := map[string]bool{}
	for k, v := range a.Chunks {
		if b.Chunks[k] != v {
			m[k] = true
		}
	}
	for k, v := range b.Chunks {
		if a.Chunks[k] != v {
			m[k] = true
		}
	}
	var out []int64
	for k := range m {
		o, _ := strconv.ParseInt(k, 10, 64)
		out = append(out, o)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
