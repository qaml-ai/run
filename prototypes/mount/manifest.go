package main

// A volume version as the Volume DO would hand it out: every path with its content hash, size, mode and (for a
// symlink) target. Blobs are content addressed by sha256 of their bytes, so any two versions (a base and its fork)
// that share a file share its blob, on the server and in every host cache.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
)

type Entry struct {
	Path string `json:"p"`
	Hash string `json:"h,omitempty"`
	Size int64  `json:"s"`
	Mode uint32 `json:"m"`           // permission bits only (0644 / 0755)
	Link string `json:"l,omitempty"` // symlink target; Hash is then empty
}

type Manifest struct {
	Name    string  `json:"name"`
	Version int     `json:"version"`
	Base    string  `json:"base,omitempty"` // the manifest this one was forked or committed from
	Files   []Entry `json:"files"`
}

func (m *Manifest) Sort() {
	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].Path < m.Files[j].Path })
}

func (m *Manifest) Bytes() int64 {
	var n int64
	for _, e := range m.Files {
		n += e.Size
	}
	return n
}

func hashFile(name string) (string, int64, error) {
	f, err := os.Open(name)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}

func validHash(h string) bool {
	if len(h) != 64 {
		return false
	}
	_, err := hex.DecodeString(h)
	return err == nil
}

// cleanPath rejects anything that is not a plain relative path inside the volume.
func cleanPath(p string) (string, error) {
	c := path.Clean(p)
	if c == "." || strings.HasPrefix(c, "/") || c == ".." || strings.HasPrefix(c, "../") || strings.Contains(c, "\x00") {
		return "", fmt.Errorf("bad path %q", p)
	}
	return c, nil
}

func decodeManifest(r io.Reader) (*Manifest, error) {
	var m Manifest
	if err := json.NewDecoder(r).Decode(&m); err != nil {
		return nil, err
	}
	for i := range m.Files {
		c, err := cleanPath(m.Files[i].Path)
		if err != nil {
			return nil, err
		}
		m.Files[i].Path = c
		if m.Files[i].Link == "" && !validHash(m.Files[i].Hash) {
			return nil, fmt.Errorf("%s: bad hash", c)
		}
	}
	return &m, nil
}
