package main

// The symbol index: universal-ctags definitions per shard, sorted by folded name, so `sym:` lookups are a binary
// search and prefix scan. It is per shard for the same reason postings are: a delta shard brings its own symbols.
//
//	<id>.sym   u32 count | entries (nameOff u32, nameLen u16, kind u8, _ u8, ord u32, line u32) | names

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const symEntrySz = 16

var symKinds = []string{"?", "function", "prototype", "macro", "struct", "union", "typedef", "enum", "enumerator",
	"member", "variable", "type", "method", "class", "interface", "const", "field", "package", "func", "var", "namespace",
	"constant", "module", "alias", "property"}

func kindID(k string) uint8 {
	for i, n := range symKinds {
		if n == k {
			return uint8(i)
		}
	}
	return 0
}

type SymbolTable struct {
	n       int
	entries []byte
	names   []byte
}

type symRec struct {
	name string
	kind uint8
	ord  uint32
	line uint32
}

func buildSymbols(dir, id string, blobs []pendingBlob) error {
	tmp, err := os.MkdirTemp("", "sym-"+id)
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	var list bytes.Buffer
	for i, b := range blobs {
		if len(b.Content) == 0 || len(b.Content) > maxIndexBytes || bytes.IndexByte(b.Content, 0) >= 0 {
			continue
		}
		if _, ok := extLang[b.Ext]; !ok {
			continue // ctags only for code we know
		}
		switch extLang[b.Ext] {
		case "markdown", "json", "text", "rst", "yaml", "html", "css":
			continue
		}
		name := filepath.Join(tmp, strconv.Itoa(i)+b.Ext)
		if err := os.WriteFile(name, b.Content, 0o644); err != nil {
			return err
		}
		list.WriteString(name + "\n")
	}
	var recs []symRec
	if list.Len() > 0 {
		cmd := exec.Command("ctags", "--output-format=json", "--fields=+nK", "-f", "-", "-L", "-")
		cmd.Stdin = &list
		out, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("ctags: %w", err)
		}
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			var t struct {
				Type             string `json:"_type"`
				Name, Path, Kind string
				Line             int
			}
			if json.Unmarshal(sc.Bytes(), &t) != nil || t.Type != "tag" || len(t.Name) > 200 {
				continue
			}
			base := filepath.Base(t.Path)
			ord, err := strconv.Atoi(strings.TrimSuffix(base, filepath.Ext(base)))
			if err != nil {
				continue
			}
			recs = append(recs, symRec{t.Name, kindID(t.Kind), uint32(ord), uint32(t.Line)})
		}
		if err := cmd.Wait(); err != nil {
			return fmt.Errorf("ctags: %w", err)
		}
	}
	sort.Slice(recs, func(i, j int) bool { return strings.ToLower(recs[i].name) < strings.ToLower(recs[j].name) })
	ent := make([]byte, 4+len(recs)*symEntrySz)
	binary.LittleEndian.PutUint32(ent, uint32(len(recs)))
	var names bytes.Buffer
	for i, r := range recs {
		e := ent[4+i*symEntrySz:]
		binary.LittleEndian.PutUint32(e[0:], uint32(names.Len()))
		binary.LittleEndian.PutUint16(e[4:], uint16(len(r.name)))
		e[6] = r.kind
		binary.LittleEndian.PutUint32(e[8:], r.ord)
		binary.LittleEndian.PutUint32(e[12:], r.line)
		names.WriteString(r.name)
	}
	return writeAtomic(filepath.Join(dir, id+".sym"), append(ent, names.Bytes()...))
}

func openSymbols(dir, id string) (*SymbolTable, error) {
	b, err := mmapFile(filepath.Join(dir, id+".sym"))
	if err != nil {
		return nil, err
	}
	n := int(binary.LittleEndian.Uint32(b))
	return &SymbolTable{n: n, entries: b[4 : 4+n*symEntrySz], names: b[4+n*symEntrySz:]}, nil
}

func (t *SymbolTable) at(i int) (string, uint8, int, int) {
	e := t.entries[i*symEntrySz:]
	off := binary.LittleEndian.Uint32(e[0:])
	l := binary.LittleEndian.Uint16(e[4:])
	return string(t.names[off : off+uint32(l)]), e[6], int(binary.LittleEndian.Uint32(e[8:])), int(binary.LittleEndian.Uint32(e[12:]))
}

type SymbolHit struct {
	Name  string  `json:"name"`
	Kind  string  `json:"kind"`
	Path  string  `json:"path"`
	Line  int     `json:"line"`
	Text  string  `json:"text"`
	Score float64 `json:"score"`
}

// SearchSymbols finds definitions: a name (case-insensitive prefix, exact matches first) or, with regex, any name
// matching it.
func SearchSymbols(sn *Snap, pattern string, isRegex bool, limit int) ([]SymbolHit, float64, error) {
	t0 := time.Now()
	if limit <= 0 {
		limit = 50
	}
	var re *regexp.Regexp
	if isRegex {
		var err error
		if re, err = regexp.Compile(pattern); err != nil {
			return nil, 0, err
		}
	}
	low := strings.ToLower(pattern)
	var hits []SymbolHit
	add := func(si, i int, t *SymbolTable) {
		name, kind, ord, line := t.at(i)
		pi := sn.live[si][ord]
		if pi < 0 {
			return
		}
		h := SymbolHit{Name: name, Kind: symKinds[kind], Path: sn.Paths[pi].Path, Line: line}
		if name == pattern {
			h.Score += 100
		} else if strings.ToLower(name) == low {
			h.Score += 60
		}
		switch h.Kind {
		case "function", "func", "method", "struct", "type", "class", "interface", "typedef":
			h.Score += 20
		case "prototype", "member", "field", "enumerator":
			h.Score -= 10
		}
		if lowValue.MatchString(h.Path) {
			h.Score -= 25
		}
		h.Score -= float64(len(name)-len(pattern)) * 0.5
		hits = append(hits, h)
	}
	for si, s := range sn.Shards {
		t := s.syms
		if t == nil {
			continue
		}
		if re != nil {
			for i := 0; i < t.n; i++ {
				if name, _, _, _ := t.at(i); re.MatchString(name) {
					add(si, i, t)
				}
			}
			continue
		}
		i := sort.Search(t.n, func(i int) bool { n, _, _, _ := t.at(i); return strings.ToLower(n) >= low })
		for ; i < t.n; i++ {
			n, _, _, _ := t.at(i)
			if !strings.HasPrefix(strings.ToLower(n), low) {
				break
			}
			add(si, i, t)
			if len(hits) > 20000 {
				break
			}
		}
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].Path < hits[j].Path
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	// line text for the returned hits only
	for i := range hits {
		w := sn.where[sn.Paths[pathIndex(sn, hits[i].Path)].ID]
		c := sn.Shards[int(w>>32)].content(int(uint32(w)))
		hits[i].Text = nthLine(c, hits[i].Line)
	}
	return hits, ms(time.Since(t0)), nil
}

func pathIndex(sn *Snap, p string) int {
	if i := sort.Search(len(sn.Paths), func(i int) bool { return sn.Paths[i].Path >= p }); i < len(sn.Paths) && sn.Paths[i].Path == p {
		return i
	}
	for i := range sn.Paths { // git's tree order differs from byte order in rare cases
		if sn.Paths[i].Path == p {
			return i
		}
	}
	return 0
}

func nthLine(c []byte, n int) string {
	for i := 1; i < n; i++ {
		k := bytes.IndexByte(c, '\n')
		if k < 0 {
			return ""
		}
		c = c[k+1:]
	}
	if k := bytes.IndexByte(c, '\n'); k >= 0 {
		c = c[:k]
	}
	return truncLine(c)
}
