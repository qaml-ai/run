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
	members     map[string]map[int]string
	V           int                 `json:"v"`
	ParentRoot  string              `json:"parentRoot"`
	Tree        string              `json:"tree"`
	VirtualSize int64               `json:"virtualSize"`
	FSType      string              `json:"fsType"`
	Chunks      map[string]string   `json:"chunks"`
	Locations   map[string]Location `json:"locations,omitempty"`
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
	used := map[string]bool{}
	for _, h := range r.Chunks {
		used[h] = true
	}
	positions := map[Location]string{}
	for h, l := range r.Locations {
		if !used[h] {
			return fmt.Errorf("unreferenced location")
		}
		if old, ok := positions[l]; ok && old != h {
			return fmt.Errorf("conflicting location")
		}
		positions[l] = h
		if !Hex(h, 64) || !Hex(l.Pack, 64) || l.Index < 0 || l.Index >= 64 {
			return fmt.Errorf("invalid location")
		}
	}
	if r.Locations != nil {
		for _, h := range r.Chunks {
			if _, ok := r.Locations[h]; !ok {
				return fmt.Errorf("missing location")
			}
		}
	}
	return nil
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
	if r.Locations != nil {
		m["locations"] = r.Locations
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

// Location encodes as [packId, chunkIndex].
type Location struct {
	Pack  string
	Index int
}

func (l Location) MarshalJSON() ([]byte, error) { return json.Marshal([2]any{l.Pack, l.Index}) }
func (l *Location) UnmarshalJSON(b []byte) error {
	var parts []json.RawMessage
	if e := json.Unmarshal(b, &parts); e != nil {
		return e
	}
	if len(parts) != 2 {
		return fmt.Errorf("invalid location")
	}
	if e := json.Unmarshal(parts[0], &l.Pack); e != nil {
		return e
	}
	return json.Unmarshal(parts[1], &l.Index)
}

// Indexed builds a read plan once per root, rather than scanning all locations
// for every cold chunk. Writers encode only the public root fields.
func (r Root) Indexed() Root {
	r.members = map[string]map[int]string{}
	for h, l := range r.Locations {
		if r.members[l.Pack] == nil {
			r.members[l.Pack] = map[int]string{}
		}
		r.members[l.Pack][l.Index] = h
	}
	return r
}
func (r Root) Members(pack string) map[int]string {
	if r.members == nil {
		r = r.Indexed()
	}
	return r.members[pack]
}
