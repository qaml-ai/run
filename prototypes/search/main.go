// camelsearch: a trigram + symbol code search over content-addressed snapshots (prototype; see DESIGN.md).
//
//	camelsearch index   -store S -repo R -commit C [-parent P,...] [-ref NAME] [-symbols]
//	camelsearch fork    -store S -from REF -name NAME
//	camelsearch compact -store S -snap REF [-limit BYTES]
//	camelsearch search  -store S -snap REF [-regex] [-i] [-path G] [-file G] [-lang L] [-context N] PATTERN
//	camelsearch sym     -store S -snap REF [-regex] NAME
//	camelsearch serve   -store S -addr :7700
//	camelsearch bench   -store S -snap REF -queries Q.json [-n 20]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
)

func die(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func out(v any) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: camelsearch index|fork|compact|search|sym|serve|bench ...")
		os.Exit(2)
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	storeDir := fs.String("store", "store", "index store directory")
	repo := fs.String("repo", ".", "git repository")
	commit := fs.String("commit", "HEAD", "commit to index")
	parent := fs.String("parent", "", "comma-separated parent snapshots/refs")
	ref := fs.String("ref", "", "ref to point at the indexed tree")
	symbols := fs.Bool("symbols", false, "build the ctags symbol index")
	shardMB := fs.Int("shard-mb", 64, "content MB per shard")
	from := fs.String("from", "", "fork source")
	name := fs.String("name", "", "fork name")
	snap := fs.String("snap", "", "snapshot ref or tree")
	isRe := fs.Bool("regex", false, "pattern is a regexp")
	ic := fs.Bool("i", false, "case-insensitive")
	pathG := fs.String("path", "", "path glob")
	fileG := fs.String("file", "", "basename glob")
	lang := fs.String("lang", "", "language")
	ctx := fs.Int("context", 0, "context lines")
	limit := fs.Int("limit", 20, "files")
	addr := fs.String("addr", ":7700", "listen address")
	queries := fs.String("queries", "", "bench query file")
	n := fs.Int("n", 20, "bench repetitions per query")
	climit := fs.Int64("limit-bytes", 32<<20, "compact shards below this content size")
	fs.Parse(os.Args[2:])
	st, err := openStore(*storeDir)
	if err != nil {
		die(err)
	}
	st.Symbols = *symbols
	st.ShardTarget = int64(*shardMB) << 20

	switch cmd {
	case "index":
		var parents []string
		if *parent != "" {
			parents = strings.Split(*parent, ",")
		}
		t0 := time.Now()
		s, err := st.Ingest(*repo, *commit, parents)
		if err != nil {
			die(err)
		}
		if *ref != "" {
			if err := st.SetRef(*ref, s.Tree); err != nil {
				die(err)
			}
		}
		s.TotalMs = ms(time.Since(t0))
		out(s)
	case "fork":
		t0 := time.Now()
		tree, err := st.Fork(*from, *name)
		if err != nil {
			die(err)
		}
		out(map[string]any{"tree": tree, "ms": ms(time.Since(t0))})
	case "compact":
		r, err := st.Compact(*snap, *climit)
		if err != nil {
			die(err)
		}
		out(r)
	case "search", "sym":
		t0 := time.Now()
		sn, err := st.Open(*snap)
		if err != nil {
			die(err)
		}
		openMs := ms(time.Since(t0))
		if cmd == "sym" {
			hits, qms, err := SearchSymbols(sn, strings.Join(fs.Args(), " "), *isRe, *limit)
			if err != nil {
				die(err)
			}
			out(map[string]any{"openMs": openMs, "ms": qms, "hits": hits})
			return
		}
		r, err := Search(sn, Query{Pattern: strings.Join(fs.Args(), " "), Regex: *isRe, IgnoreCase: *ic, PathGlob: *pathG,
			FileGlob: *fileG, Lang: *lang, Context: *ctx, Limit: *limit})
		if err != nil {
			die(err)
		}
		out(map[string]any{"openMs": openMs, "result": r})
	case "serve":
		serve(st, *addr)
	case "bench":
		bench(st, *snap, *queries, *n)
	case "gen":
		gen(*name, *n, int(*climit))
	default:
		die(fmt.Errorf("unknown command %s", cmd))
	}
}

// ---- HTTP: the tool surface (an agent tool calls this with a snapshot or fork ref; no VM needed) ----

func serve(st *Store, addr string) {
	mux := http.NewServeMux()
	reply := func(w http.ResponseWriter, v any, err error) {
		w.Header().Set("content-type", "application/json")
		if err != nil {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("GET /v1/snapshots/{ref}/search", func(w http.ResponseWriter, r *http.Request) {
		v := r.URL.Query()
		sn, err := st.Open(r.PathValue("ref"))
		if err != nil {
			reply(w, nil, err)
			return
		}
		atoi := func(k string) int { n, _ := strconv.Atoi(v.Get(k)); return n }
		q := Query{Pattern: v.Get("q"), Regex: v.Get("regex") == "1", IgnoreCase: v.Get("i") == "1",
			PathGlob: v.Get("path"), FileGlob: v.Get("file"), Lang: v.Get("lang"), Context: atoi("context"),
			Limit: atoi("limit"), LinesPer: atoi("lines")}
		res, err := Search(sn, q)
		reply(w, res, err)
	})
	mux.HandleFunc("GET /v1/snapshots/{ref}/symbols", func(w http.ResponseWriter, r *http.Request) {
		sn, err := st.Open(r.PathValue("ref"))
		if err != nil {
			reply(w, nil, err)
			return
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		hits, qms, err := SearchSymbols(sn, r.URL.Query().Get("q"), r.URL.Query().Get("regex") == "1", limit)
		reply(w, map[string]any{"ms": qms, "hits": hits}, err)
	})
	mux.HandleFunc("POST /v1/snapshots/{ref}/fork", func(w http.ResponseWriter, r *http.Request) {
		tree, err := st.Fork(r.PathValue("ref"), r.URL.Query().Get("name"))
		reply(w, map[string]string{"tree": tree}, err)
	})
	mux.HandleFunc("POST /v1/index", func(w http.ResponseWriter, r *http.Request) {
		v := r.URL.Query()
		var parents []string
		if p := v.Get("parent"); p != "" {
			parents = strings.Split(p, ",")
		}
		s, err := st.Ingest(v.Get("repo"), v.Get("commit"), parents)
		if err == nil && v.Get("ref") != "" {
			err = st.SetRef(v.Get("ref"), s.Tree)
		}
		reply(w, s, err)
	})
	fmt.Fprintln(os.Stderr, "listening on", addr)
	die(http.ListenAndServe(addr, mux))
}

// ---- bench: latency per query, in process ----

type BenchQuery struct {
	Class string `json:"class"` // literal | regex | path | symbol | ...
	Query
	Symbol string `json:"symbol,omitempty"`
}

func pct(xs []float64, p float64) float64 {
	s := slices.Clone(xs)
	slices.Sort(s)
	i := int(p*float64(len(s)-1) + 0.5)
	return s[i]
}

func bench(st *Store, snap, qfile string, n int) {
	t0 := time.Now()
	sn, err := st.Open(snap)
	if err != nil {
		die(err)
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	out(map[string]any{"event": "open", "ms": ms(time.Since(t0)), "files": len(sn.Paths), "shards": len(sn.Shards),
		"heapMB": mem.HeapAlloc >> 20})
	b, err := os.ReadFile(qfile)
	if err != nil {
		die(err)
	}
	var qs []BenchQuery
	if err := json.Unmarshal(b, &qs); err != nil {
		die(err)
	}
	byClass := map[string][]float64{}
	var order []string
	for _, bq := range qs {
		var lat []float64
		var first float64
		var last any
		for i := 0; i < n+1; i++ {
			t := time.Now()
			if bq.Symbol != "" {
				hits, _, err := SearchSymbols(sn, bq.Symbol, bq.Regex, 20)
				if err != nil {
					die(err)
				}
				last = map[string]any{"hits": len(hits), "top": firstOr(hits)}
			} else {
				r, err := Search(sn, bq.Query)
				if err != nil {
					die(err)
				}
				top := ""
				if len(r.Files) > 0 {
					top = r.Files[0].Path
				}
				last = map[string]any{"fileHits": r.Stats.FileHits, "candidates": r.Stats.Candidates,
					"verified": r.Stats.Verified, "truncated": r.Stats.Truncated, "top": top}
			}
			d := ms(time.Since(t))
			if i == 0 {
				first = d // first run: page faults on the mmapped shards
				continue
			}
			lat = append(lat, d)
		}
		if _, ok := byClass[bq.Class]; !ok {
			order = append(order, bq.Class)
		}
		byClass[bq.Class] = append(byClass[bq.Class], lat...)
		label := bq.Pattern
		if bq.Symbol != "" {
			label = "sym:" + bq.Symbol
		}
		if bq.PathGlob != "" {
			label += " path:" + bq.PathGlob
		}
		if bq.FileGlob != "" {
			label += " file:" + bq.FileGlob
		}
		if bq.Lang != "" {
			label += " lang:" + bq.Lang
		}
		out(map[string]any{"event": "query", "class": bq.Class, "q": label, "regex": bq.Regex, "i": bq.IgnoreCase,
			"firstMs": first, "p50": pct(lat, 0.5), "p99": pct(lat, 0.99), "result": last})
	}
	var memLine string
	if b, err := os.ReadFile("/proc/self/status"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "VmHWM") || strings.HasPrefix(l, "RssAnon") || strings.HasPrefix(l, "RssFile") {
				memLine += strings.Join(strings.Fields(l), " ") + "; "
			}
		}
	}
	runtime.ReadMemStats(&mem)
	out(map[string]any{"event": "mem", "proc": memLine, "heapMB": mem.HeapAlloc >> 20, "sysMB": mem.Sys >> 20})
	for _, c := range order {
		out(map[string]any{"event": "class", "class": c, "n": len(byClass[c]), "p50": pct(byClass[c], 0.5),
			"p99": pct(byClass[c], 0.99)})
	}
}

func firstOr(h []SymbolHit) any {
	if len(h) == 0 {
		return nil
	}
	return h[0].Path + ":" + strconv.Itoa(h[0].Line)
}

// gen writes the sibling prototypes' synthetic tree (proto/artifacts-volumes bench.ts: same paths, same generator).
func gen(dir string, files, bytesPer int) {
	words := strings.Fields("const let function return import export async await class interface type string number boolean void null undefined if else for while switch case break continue throw try catch finally new this super extends implements public private static readonly")
	for i := 0; i < files; i++ {
		p := fmt.Sprintf("%s/src/m%d/d%d/f%d.ts", dir, i/2500, i/50, i)
		os.MkdirAll(p[:strings.LastIndexByte(p, '/')], 0o755)
		x := uint32(uint64(i) * 2654435761)
		next := func() uint32 { x = x*1664525 + 1013904223; return x }
		var b strings.Builder
		fmt.Fprintf(&b, "// file %d\n", i)
		for b.Len() < bytesPer {
			var line []string
			for n := 2 + next()%9; n > 0; n-- {
				line = append(line, words[next()%uint32(len(words))])
			}
			ind := strings.Repeat("  ", int(next()%4))
			end := " {"
			if next()%3 != 0 {
				end = ";"
			}
			b.WriteString(ind + strings.Join(line, " ") + end + "\n")
		}
		if err := os.WriteFile(p, []byte(b.String()), 0o644); err != nil {
			die(err)
		}
	}
}
