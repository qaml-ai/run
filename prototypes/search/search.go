package main

import (
	"bytes"
	"errors"
	"math"
	"path"
	"regexp"
	"regexp/syntax"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/codesearch/index"
)

type Query struct {
	Pattern    string `json:"q"`
	Regex      bool   `json:"regex"`
	IgnoreCase bool   `json:"i"`
	PathGlob   string `json:"path"` // glob on the full path: ** any dirs, * within a segment
	FileGlob   string `json:"file"` // glob on the basename
	Lang       string `json:"lang"`
	Context    int    `json:"context"`
	Limit      int    `json:"limit"`    // files returned
	MaxFiles   int    `json:"maxFiles"` // stop verifying after this many matching files (results flagged truncated)
	LinesPer   int    `json:"linesPerFile"`
}

type LineMatch struct {
	Line   int      `json:"line"`
	Text   string   `json:"text"`
	Ranges [][2]int `json:"ranges"`
	Before []string `json:"before,omitempty"`
	After  []string `json:"after,omitempty"`
}

type FileMatch struct {
	Path    string      `json:"path"`
	Lang    string      `json:"lang,omitempty"`
	Blob    string      `json:"blob"`
	Score   float64     `json:"score"`
	Matches int         `json:"matches"`
	Lines   []LineMatch `json:"lines,omitempty"`
	si, ord int
	locs    [][]int
}

type SearchStats struct {
	Shards     int     `json:"shards"`
	Candidates int64   `json:"candidates"` // blobs surviving the trigram filter (before the live mask and path filters)
	Verified   int64   `json:"verified"`
	FileHits   int64   `json:"fileHits"` // matching blobs (distinct contents); path search: matching paths
	Truncated  bool    `json:"truncated"`
	IndexQuery string  `json:"indexQuery"`
	Ms         float64 `json:"ms"`
}

type SearchResult struct {
	Tree  string      `json:"tree"`
	Files []FileMatch `json:"files"`
	Stats SearchStats `json:"stats"`
}

type pathFilter struct {
	pathGlob, fileGlob string
	pathLit, fileLit   string // literals the path / basename must contain: a cheap pre-check before the glob
	lang               int    // -1 any
}

// matchGlob matches name against a glob: ? and * stay inside a path segment, ** crosses segments ("a/**/b" also
// matches "a/b"). Iterative with one backtrack point per star kind, like the classic wildcard matcher.
func matchGlob(pat, name string) bool {
	if pat == "" {
		return name == ""
	}
	switch {
	case strings.HasPrefix(pat, "**/"):
		rest := pat[3:]
		if matchGlob(rest, name) {
			return true
		}
		for i := 0; i < len(name); i++ {
			if name[i] == '/' && matchGlob(rest, name[i+1:]) {
				return true
			}
		}
		return false
	case strings.HasPrefix(pat, "**"):
		rest := pat[2:]
		for i := 0; i <= len(name); i++ {
			if matchGlob(rest, name[i:]) {
				return true
			}
		}
		return false
	case pat[0] == '*':
		rest := pat[1:]
		for i := 0; i <= len(name); i++ {
			if matchGlob(rest, name[i:]) {
				return true
			}
			if i < len(name) && name[i] == '/' {
				return false
			}
		}
		return false
	case name == "":
		return false
	case pat[0] == '?':
		return name[0] != '/' && matchGlob(pat[1:], name[1:])
	default:
		// consume the literal run in one step
		k := strings.IndexAny(pat, "*?")
		if k < 0 {
			k = len(pat)
		}
		return strings.HasPrefix(name, pat[:k]) && matchGlob(pat[k:], name[k:])
	}
}

func longestLiteral(g string) string {
	best := ""
	for _, part := range strings.FieldsFunc(g, func(r rune) bool { return r == '*' || r == '?' }) {
		if len(part) > len(best) {
			best = part
		}
	}
	return best
}

func newPathFilter(q *Query) (*pathFilter, error) {
	f := &pathFilter{lang: -1}
	if q.PathGlob != "" {
		// gitignore rules: a glob with a slash before its end is anchored at the root ("pkg/**/types.go");
		// one without ("*.pb.go", "vendor/") matches at any depth.
		f.pathGlob = strings.TrimPrefix(q.PathGlob, "/")
		if !strings.Contains(strings.TrimSuffix(q.PathGlob, "/"), "/") {
			f.pathGlob = "**/" + strings.TrimSuffix(f.pathGlob, "/")
			if strings.HasSuffix(q.PathGlob, "/") {
				f.pathGlob += "/**"
			}
		}
		f.pathLit = strings.TrimPrefix(longestLiteral(q.PathGlob), "/")
	}
	f.fileGlob = q.FileGlob
	f.fileLit = longestLiteral(q.FileGlob)
	if q.Lang != "" {
		f.lang = langID(q.Lang)
		if f.lang < 0 {
			return nil, errors.New("unknown language " + q.Lang)
		}
	}
	return f, nil
}

func (f *pathFilter) any() bool { return f.pathGlob != "" || f.fileGlob != "" || f.lang >= 0 }

func (f *pathFilter) ok(sn *Snap, pi int32) bool {
	if f.lang >= 0 && int(sn.Lang[pi]) != f.lang {
		return false
	}
	p := sn.Paths[pi].Path
	if f.pathGlob != "" {
		if f.pathLit != "" && !strings.Contains(p, f.pathLit) {
			return false
		}
		if !matchGlob(f.pathGlob, p) {
			return false
		}
	}
	if f.fileGlob != "" {
		base := p[strings.LastIndexByte(p, '/')+1:]
		if f.fileLit != "" && !strings.Contains(base, f.fileLit) || !matchGlob(f.fileGlob, base) {
			return false
		}
	}
	return true
}

// foldForIndex rewrites a parsed regexp to the index's ASCII-folded alphabet: literals lowercased, classes gain the
// lowercase twin of any A-Z they contain. The rewritten regexp matches a superset (as trigram filters must).
func foldForIndex(re *syntax.Regexp) {
	switch re.Op {
	case syntax.OpLiteral:
		for i, r := range re.Rune {
			if r >= 'A' && r <= 'Z' {
				re.Rune[i] = r + 32
			}
		}
		re.Flags &^= syntax.FoldCase
	case syntax.OpCharClass:
		var add []rune
		for i := 0; i+1 < len(re.Rune); i += 2 {
			lo, hi := max(re.Rune[i], 'A'), min(re.Rune[i+1], 'Z')
			if lo <= hi {
				add = append(add, lo+32, hi+32)
			}
		}
		if len(add) > 0 {
			re.Rune = append(re.Rune, add...)
			// re-normalise ranges (sorted, merged) the way syntax expects
			type rg struct{ lo, hi rune }
			var rs []rg
			for i := 0; i+1 < len(re.Rune); i += 2 {
				rs = append(rs, rg{re.Rune[i], re.Rune[i+1]})
			}
			sort.Slice(rs, func(i, j int) bool { return rs[i].lo < rs[j].lo })
			out := re.Rune[:0]
			for _, r := range rs {
				if n := len(out); n > 0 && r.lo <= out[n-1]+1 {
					out[n-1] = max(out[n-1], r.hi)
				} else {
					out = append(out, r.lo, r.hi)
				}
			}
			re.Rune = out
		}
	}
	for _, s := range re.Sub {
		foldForIndex(s)
	}
}

func triKey(t string) uint32 { return uint32(t[0])<<16 | uint32(t[1])<<8 | uint32(t[2]) }

// evalIndex returns the sorted ordinals matching q in shard s; all=true means "every blob" (no usable trigrams).
func evalIndex(q *index.Query, s *Shard) (list []uint32, all bool) {
	switch q.Op {
	case index.QAll:
		return nil, true
	case index.QNone:
		return nil, false
	case index.QAnd:
		tris := slices.Clone(q.Trigram)
		sort.Slice(tris, func(i, j int) bool { return s.postingCount(triKey(tris[i])) < s.postingCount(triKey(tris[j])) })
		have := false
		for _, t := range tris {
			p := s.postings(triKey(t), nil)
			if !have {
				list, have = p, true
			} else {
				list = intersect(list, p)
			}
			if len(list) == 0 {
				return nil, false
			}
		}
		for _, sub := range q.Sub {
			l, a := evalIndex(sub, s)
			if a {
				continue
			}
			if !have {
				list, have = l, true
			} else {
				list = intersect(list, l)
			}
			if len(list) == 0 {
				return nil, false
			}
		}
		if !have {
			return nil, true
		}
		return list, false
	case index.QOr:
		for _, t := range q.Trigram {
			list = union(list, s.postings(triKey(t), nil))
		}
		for _, sub := range q.Sub {
			l, a := evalIndex(sub, s)
			if a {
				return nil, true
			}
			list = union(list, l)
		}
		return list, false
	}
	return nil, true
}

func intersect(a, b []uint32) []uint32 {
	out := a[:0]
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] < b[j]:
			i++
		case a[i] > b[j]:
			j++
		default:
			out = append(out, a[i])
			i++
			j++
		}
	}
	return out
}

func union(a, b []uint32) []uint32 {
	if len(a) == 0 {
		return b
	}
	out := make([]uint32, 0, len(a)+len(b))
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		switch {
		case j == len(b) || (i < len(a) && a[i] < b[j]):
			out = append(out, a[i])
			i++
		case i == len(a) || b[j] < a[i]:
			out = append(out, b[j])
			j++
		default:
			out = append(out, a[i])
			i++
			j++
		}
	}
	return out
}

// matcher verifies a candidate blob. Three paths, fastest first:
//   - a case-sensitive literal: bytes.Index;
//   - a regexp with a required literal set (every match contains one of them, e.g. "todo" or "fixme" for
//     todo|fixme): find the literals (in a folded copy when any part is case-insensitive), then run the regexp on
//     those lines only. Matches are line-oriented, like grep;
//   - otherwise the regexp over the whole blob.
type matcher struct {
	lit    []byte   // case-sensitive literal fast path
	needs  [][]byte // required literal set for the line prefilter (lowercased when fold)
	fold   bool
	re     *regexp.Regexp
	lineRe *regexp.Regexp // the regexp without (?m), for single lines
}

// requiredSet returns literals such that every match of re contains at least one of them (nil when there is none).
func requiredSet(re *syntax.Regexp) []string {
	switch re.Op {
	case syntax.OpLiteral:
		return []string{string(re.Rune)}
	case syntax.OpCapture, syntax.OpPlus:
		return requiredSet(re.Sub[0])
	case syntax.OpRepeat:
		if re.Min >= 1 {
			return requiredSet(re.Sub[0])
		}
	case syntax.OpConcat:
		var best []string
		better := func(c []string) {
			if c != nil && (best == nil || minLen(c) > minLen(best) || (minLen(c) == minLen(best) && len(c) < len(best))) {
				best = c
			}
		}
		run := ""
		for _, sub := range re.Sub {
			if sub.Op == syntax.OpLiteral {
				run += string(sub.Rune)
				better([]string{run})
				continue
			}
			run = ""
			better(requiredSet(sub))
		}
		return best
	case syntax.OpAlternate:
		var out []string
		for _, sub := range re.Sub {
			c := requiredSet(sub)
			if c == nil || len(out)+len(c) > 16 {
				return nil
			}
			out = append(out, c...)
		}
		return out
	}
	return nil
}

func minLen(xs []string) int {
	m := 1 << 30
	for _, x := range xs {
		m = min(m, len(x))
	}
	return m
}

func hasFold(re *syntax.Regexp) bool {
	if re.Flags&syntax.FoldCase != 0 {
		return true
	}
	for _, s := range re.Sub {
		if hasFold(s) {
			return true
		}
	}
	return false
}

func foldInto(dst, src []byte) []byte {
	dst = append(dst[:0], src...)
	for i, c := range dst {
		if c >= 'A' && c <= 'Z' {
			dst[i] = c + 32
		}
	}
	return dst
}

func (m *matcher) find(c []byte, n int, scratch *[]byte) [][]int {
	if m.lit != nil {
		var out [][]int
		off := 0
		for len(out) < n {
			i := bytes.Index(c[off:], m.lit)
			if i < 0 {
				break
			}
			out = append(out, []int{off + i, off + i + len(m.lit)})
			off += i + max(len(m.lit), 1)
		}
		return out
	}
	if m.needs == nil {
		return m.re.FindAllIndex(c, n)
	}
	hay := c
	if m.fold {
		*scratch = foldInto(*scratch, c)
		hay = *scratch
	}
	lineOf := func(i int) (int, int) {
		ls := bytes.LastIndexByte(c[:i], '\n') + 1
		le := bytes.IndexByte(c[i:], '\n')
		if le < 0 {
			return ls, len(c)
		}
		return ls, le + i
	}
	var out [][]int
	if len(m.needs) == 1 {
		off := 0
		for len(out) < n && off < len(c) {
			i := bytes.Index(hay[off:], m.needs[0])
			if i < 0 {
				break
			}
			ls, le := lineOf(i + off)
			for _, loc := range m.lineRe.FindAllIndex(c[ls:le], n-len(out)) {
				out = append(out, []int{ls + loc[0], ls + loc[1]})
			}
			off = le + 1
		}
		return out
	}
	var lines [][2]int
	for _, nd := range m.needs {
		off := 0
		for off < len(c) {
			i := bytes.Index(hay[off:], nd)
			if i < 0 {
				break
			}
			ls, le := lineOf(i + off)
			lines = append(lines, [2]int{ls, le})
			off = le + 1
		}
	}
	sort.Slice(lines, func(i, j int) bool { return lines[i][0] < lines[j][0] })
	last := -1
	for _, l := range lines {
		if l[0] == last || len(out) >= n {
			continue
		}
		last = l[0]
		for _, loc := range m.lineRe.FindAllIndex(c[l[0]:l[1]], n-len(out)) {
			out = append(out, []int{l[0] + loc[0], l[0] + loc[1]})
		}
	}
	return out
}

const maxMatchesPerFile = 200

func Search(sn *Snap, q Query) (*SearchResult, error) {
	t0 := time.Now()
	if q.Limit <= 0 {
		q.Limit = 50
	}
	if q.MaxFiles <= 0 {
		q.MaxFiles = 2000
	}
	if q.LinesPer <= 0 {
		q.LinesPer = 5
	}
	pf, err := newPathFilter(&q)
	if err != nil {
		return nil, err
	}
	res := &SearchResult{Tree: sn.M.Tree}
	res.Stats.Shards = len(sn.Shards)
	if q.Pattern == "" {
		return pathSearch(sn, q, pf, res, t0), nil
	}
	src := q.Pattern
	if !q.Regex {
		src = regexp.QuoteMeta(q.Pattern)
	}
	flags := "(?m)"
	if q.IgnoreCase {
		flags = "(?mi)"
	}
	vre, err := regexp.Compile(flags + src)
	if err != nil {
		return nil, err
	}
	m := &matcher{re: vre, fold: q.IgnoreCase}
	if !q.Regex && !q.IgnoreCase {
		m.lit = []byte(q.Pattern)
	}
	sf := syntax.Perl
	if q.IgnoreCase {
		sf |= syntax.FoldCase
	}
	pre, err := syntax.Parse(src, sf)
	if err != nil {
		return nil, err
	}
	if m.lit == nil {
		if lp, err := syntax.Parse(src, syntax.Perl); err == nil {
			lp = lp.Simplify()
			m.fold = q.IgnoreCase || hasFold(lp)
			set := requiredSet(lp)
			ok := set != nil && minLen(set) >= 2
			for _, nd := range set {
				if m.fold {
					nd = strings.ToLower(nd)
				}
				if strings.ContainsRune(nd, '\n') || (m.fold && !isASCII(nd)) {
					ok = false
				}
				m.needs = append(m.needs, []byte(nd))
			}
			if !ok {
				m.needs = nil
			}
		}
		lf := ""
		if q.IgnoreCase {
			lf = "(?i)"
		}
		if m.lineRe, err = regexp.Compile(lf + src); err != nil {
			return nil, err
		}
	}
	foldForIndex(pre)
	iq := index.RegexpQuery(pre.Simplify())
	res.Stats.IndexQuery = iq.String()

	var hits atomic.Int64
	var verified atomic.Int64
	var truncated atomic.Bool
	var mu sync.Mutex
	var files []FileMatch

	// Work items: (shard, candidate list); shards fan out over cores, and big candidate lists are split.
	type item struct {
		si   int
		ords []uint32
		all  bool
		lo   int
		hi   int
	}
	var items []item
	var trigramCands int64
	for si, s := range sn.Shards {
		l, all := evalIndex(iq, s)
		n := len(l)
		if all {
			n = s.nBlob
		}
		trigramCands += int64(n)
		const chunk = 64
		for lo := 0; lo < n; lo += chunk {
			items = append(items, item{si, l, all, lo, min(lo+chunk, n)})
		}
	}
	work := make(chan item)
	var wg sync.WaitGroup
	for w := 0; w < runtime.NumCPU(); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var local []FileMatch
			var pis []int32
			var scratch []byte
			for it := range work {
				s := sn.Shards[it.si]
				live := sn.live[it.si]
				for k := it.lo; k < it.hi; k++ {
					if hits.Load() >= int64(q.MaxFiles) {
						truncated.Store(true)
						break
					}
					ord := k
					if !it.all {
						ord = int(it.ords[k])
					}
					first := live[ord]
					if first < 0 || s.blobFlags(ord) != 0 {
						continue
					}
					pis = pis[:0]
					if pf.ok(sn, first) {
						pis = append(pis, first)
					}
					for _, pi := range sn.more[int64(it.si)<<32|int64(ord)] {
						if pf.ok(sn, pi) {
							pis = append(pis, pi)
						}
					}
					if len(pis) == 0 {
						continue
					}
					verified.Add(1)
					locs := m.find(s.content(ord), maxMatchesPerFile, &scratch)
					if len(locs) == 0 {
						continue
					}
					hits.Add(1)
					for _, pi := range pis {
						local = append(local, FileMatch{Path: sn.Paths[pi].Path, Lang: langName(sn.Lang[pi]),
							Blob: sn.Paths[pi].ID.String(), Matches: len(locs), si: it.si, ord: ord, locs: locs})
					}
				}
			}
			mu.Lock()
			files = append(files, local...)
			mu.Unlock()
		}()
	}
	for _, it := range items {
		work <- it
	}
	close(work)
	wg.Wait()

	defs := definitionSets(sn, q)
	for i := range files {
		files[i].Score = score(&files[i], q, vre)
		if defs[int64(files[i].si)<<32|int64(files[i].ord)] {
			files[i].Score += 30 // the file defines the symbol searched for
		}
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].Score != files[j].Score {
			return files[i].Score > files[j].Score
		}
		return files[i].Path < files[j].Path
	})
	if len(files) > q.Limit {
		files = files[:q.Limit]
	}
	for i := range files {
		f := &files[i]
		f.Lines = lineContext(sn.Shards[f.si].content(f.ord), f.locs, q.Context, q.LinesPer)
		f.locs = nil
	}
	res.Files = files
	res.Stats.Candidates, res.Stats.Verified, res.Stats.FileHits = trigramCands, verified.Load(), hits.Load()
	res.Stats.Truncated = truncated.Load()
	res.Stats.Ms = ms(time.Since(t0))
	return res, nil
}

var lowValue = regexp.MustCompile(`(^|/)(test|tests|testdata|vendor|third_party|node_modules|generated|docs?|Documentation)(/|$)|_test\.|\.min\.|\.pb\.go$|zz_generated`)

// score: more matches help (sub-linearly), a basename hit helps most, a shallow path a little; tests, vendored and
// generated code sink. Symbol definitions win when the shard has a symbol table.
func score(f *FileMatch, q Query, re *regexp.Regexp) float64 {
	s := 10 * math.Log2(1+float64(f.Matches))
	if re.MatchString(path.Base(f.Path)) {
		s += 40
	}
	if lowValue.MatchString(f.Path) {
		s -= 25
	}
	s -= 0.5 * float64(strings.Count(f.Path, "/"))
	return s
}

func lineContext(c []byte, locs [][]int, ctx, maxLines int) []LineMatch {
	var out []LineMatch
	line, pos := 1, 0
	for _, l := range locs {
		line += bytes.Count(c[pos:l[0]], []byte{'\n'})
		pos = l[0]
		ls := bytes.LastIndexByte(c[:l[0]], '\n') + 1
		le := bytes.IndexByte(c[l[0]:], '\n')
		if le < 0 {
			le = len(c)
		} else {
			le += l[0]
		}
		if n := len(out); n > 0 && out[n-1].Line == line {
			out[n-1].Ranges = append(out[n-1].Ranges, [2]int{l[0] - ls, min(l[1], le) - ls})
			continue
		}
		if len(out) == maxLines {
			break
		}
		lm := LineMatch{Line: line, Text: truncLine(c[ls:le]), Ranges: [][2]int{{l[0] - ls, min(l[1], le) - ls}}}
		if ctx > 0 {
			b := ls
			for k := 0; k < ctx && b > 0; k++ {
				pb := bytes.LastIndexByte(c[:b-1], '\n') + 1
				lm.Before = append([]string{truncLine(c[pb : b-1])}, lm.Before...)
				b = pb
			}
			a := le
			for k := 0; k < ctx && a < len(c); k++ {
				na := bytes.IndexByte(c[a+1:], '\n')
				if na < 0 {
					na = len(c) - a - 1
				}
				lm.After = append(lm.After, truncLine(c[a+1:a+1+na]))
				a += 1 + na
			}
		}
		out = append(out, lm)
	}
	return out
}

func truncLine(b []byte) string {
	if len(b) > 300 {
		b = b[:300]
	}
	return string(b)
}

func pathSearch(sn *Snap, q Query, pf *pathFilter, res *SearchResult, t0 time.Time) *SearchResult {
	var files []FileMatch
	n := 0
	for pi := range sn.Paths {
		if pf.ok(sn, int32(pi)) {
			n++
			if len(files) < q.MaxFiles {
				p := sn.Paths[pi]
				files = append(files, FileMatch{Path: p.Path, Lang: langName(sn.Lang[pi]), Blob: p.ID.String(),
					Score: -float64(len(p.Path))})
			}
		}
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].Score > files[j].Score })
	if len(files) > q.Limit {
		files = files[:q.Limit]
	}
	res.Files = files
	res.Stats.FileHits = int64(n)
	res.Stats.Ms = ms(time.Since(t0))
	return res
}

// ---- languages ----

var langNames = []string{"", "go", "c", "cpp", "python", "javascript", "typescript", "rust", "java", "shell", "markdown",
	"yaml", "json", "make", "rst", "assembly", "proto", "html", "css", "text", "dts", "kconfig"}

var extLang = map[string]string{
	".go": "go", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".cxx": "cpp", ".py": "python",
	".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript", ".ts": "typescript",
	".tsx": "typescript", ".mts": "typescript", ".rs": "rust", ".java": "java", ".sh": "shell", ".bash": "shell",
	".md": "markdown", ".yaml": "yaml", ".yml": "yaml", ".json": "json", ".mk": "make", ".rst": "rst", ".S": "assembly",
	".s": "assembly", ".proto": "proto", ".html": "html", ".css": "css", ".txt": "text", ".dts": "dts", ".dtsi": "dts",
}

func langID(name string) int {
	for i, n := range langNames {
		if i > 0 && n == strings.ToLower(name) {
			return i
		}
	}
	return -1
}

func langName(id uint8) string { return langNames[id] }

func langOf(p string) uint8 {
	b := path.Base(p)
	switch {
	case b == "Makefile" || b == "GNUmakefile" || strings.HasPrefix(b, "Makefile."):
		return uint8(langID("make"))
	case strings.HasPrefix(b, "Kconfig"):
		return uint8(langID("kconfig"))
	}
	if l, ok := extLang[path.Ext(b)]; ok {
		return uint8(langID(l))
	}
	return 0
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// definitionSets: for a plain identifier query, the blobs whose symbol table defines that name (for ranking).
func definitionSets(sn *Snap, q Query) map[int64]bool {
	if q.Regex || !isIdent(q.Pattern) {
		return nil
	}
	low := strings.ToLower(q.Pattern)
	out := map[int64]bool{}
	for si, s := range sn.Shards {
		t := s.syms
		if t == nil {
			continue
		}
		i := sort.Search(t.n, func(i int) bool { n, _, _, _ := t.at(i); return strings.ToLower(n) >= low })
		for ; i < t.n; i++ {
			n, kind, ord, _ := t.at(i)
			if strings.ToLower(n) != low {
				break
			}
			if (q.IgnoreCase || n == q.Pattern) && symKinds[kind] != "prototype" {
				out[int64(si)<<32|int64(ord)] = true
			}
		}
	}
	return out
}

func isIdent(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !(c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
