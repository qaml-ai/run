package main

// blobd: the stand-in for R2 (blobs by hash) and the Volume DO (manifests by name). Every request can be delayed by a
// fixed first-byte latency, which is what dominates many-small-file workloads against a real object store.
//
//   GET/HEAD/PUT /blob/<sha256>   PUT checks the hash
//   GET/PUT      /manifest/<name>
//   GET          /tar/<name>      today's camel-sync: every blob read in turn and streamed as one tar
//   GET          /stats           request counters

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

type server struct {
	dir     string
	latency atomic.Int64
	gets    atomic.Int64
	puts    atomic.Int64
	heads   atomic.Int64
	bytes   atomic.Int64
}

func (s *server) blobPath(h string) string { return filepath.Join(s.dir, "blobs", h[:2], h) }
func (s *server) manifestPath(n string) string {
	return filepath.Join(s.dir, "manifests", strings.ReplaceAll(n, "/", "_")+".json")
}

func (s *server) wait() {
	if d := time.Duration(s.latency.Load()); d > 0 {
		time.Sleep(d)
	}
}

func (s *server) blob(w http.ResponseWriter, r *http.Request) {
	h := strings.TrimPrefix(r.URL.Path, "/blob/")
	if !validHash(h) {
		http.Error(w, "bad hash", 400)
		return
	}
	s.wait()
	switch r.Method {
	case http.MethodHead:
		s.heads.Add(1)
		if _, err := os.Stat(s.blobPath(h)); err != nil {
			http.NotFound(w, r)
		}
	case http.MethodGet:
		s.gets.Add(1)
		f, err := os.Open(s.blobPath(h))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		n, _ := io.Copy(w, f)
		s.bytes.Add(n)
	case http.MethodPut:
		s.puts.Add(1)
		p := s.blobPath(h)
		os.MkdirAll(filepath.Dir(p), 0o755)
		tmp, err := os.CreateTemp(filepath.Dir(p), ".up-*")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer os.Remove(tmp.Name())
		sum := sha256.New()
		if _, err := io.Copy(io.MultiWriter(tmp, sum), r.Body); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		tmp.Close()
		if hex.EncodeToString(sum.Sum(nil)) != h {
			http.Error(w, "hash mismatch", 400)
			return
		}
		os.Rename(tmp.Name(), p)
	}
}

func (s *server) manifest(w http.ResponseWriter, r *http.Request) {
	n := strings.TrimPrefix(r.URL.Path, "/manifest/")
	s.wait()
	switch r.Method {
	case http.MethodGet:
		http.ServeFile(w, r, s.manifestPath(n))
	case http.MethodPut:
		m, err := decodeManifest(r.Body)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		// The DO would check every blob exists (and pin it) here; the prototype trusts the client.
		os.MkdirAll(filepath.Join(s.dir, "manifests"), 0o755)
		f, _ := os.Create(s.manifestPath(n))
		json.NewEncoder(f).Encode(m)
		f.Close()
	}
}

// tarStream is camel-sync phase 1: the runtime reads each file from the bucket, one after the other, and streams it.
func (s *server) tarStream(w http.ResponseWriter, r *http.Request) {
	n := strings.TrimPrefix(r.URL.Path, "/tar/")
	f, err := os.Open(s.manifestPath(n))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	m, err := decodeManifest(f)
	f.Close()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	s.wait()
	tw := tar.NewWriter(w)
	for _, e := range m.Files {
		if e.Link != "" {
			tw.WriteHeader(&tar.Header{Name: e.Path, Typeflag: tar.TypeSymlink, Linkname: e.Link, Mode: 0o777})
			continue
		}
		s.wait()
		s.gets.Add(1)
		b, err := os.ReadFile(s.blobPath(e.Hash))
		if err != nil {
			log.Printf("tar: %s: %v", e.Path, err)
			return
		}
		s.bytes.Add(int64(len(b)))
		tw.WriteHeader(&tar.Header{Name: e.Path, Typeflag: tar.TypeReg, Size: int64(len(b)), Mode: int64(e.Mode)})
		tw.Write(b)
	}
	tw.Close()
}

func serveMain(args []string) {
	fl := flag.NewFlagSet("serve", flag.ExitOnError)
	dir := fl.String("dir", "blobd", "storage directory")
	addr := fl.String("addr", "127.0.0.1:9900", "listen address")
	latency := fl.Duration("latency", 0, "added first-byte latency per request")
	fl.Parse(args)
	s := &server{dir: *dir}
	s.latency.Store(int64(*latency))
	mux := http.NewServeMux()
	mux.HandleFunc("/blob/", s.blob)
	mux.HandleFunc("/manifest/", s.manifest)
	mux.HandleFunc("/tar/", s.tarStream)
	mux.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]int64{"gets": s.gets.Load(), "puts": s.puts.Load(), "heads": s.heads.Load(), "bytes": s.bytes.Load()})
	})
	mux.HandleFunc("/latency", func(w http.ResponseWriter, r *http.Request) {
		if d, err := time.ParseDuration(r.URL.Query().Get("d")); err == nil {
			s.latency.Store(int64(d))
		}
	})
	log.Printf("blobd on %s (latency %s)", *addr, *latency)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
