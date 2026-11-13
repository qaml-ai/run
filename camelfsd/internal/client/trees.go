package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func treeCommand(socket, cmd string, args []string, out io.Writer) error {
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer tr.CloseIdleConnections()
	c := &http.Client{Transport: tr, Timeout: 10 * time.Minute}
	call := func(method, path string, body io.Reader, size int64) ([]byte, int, error) {
		req, e := http.NewRequest(method, "http://camelfsd"+path, body)
		if e != nil {
			return nil, 0, e
		}
		if size >= 0 {
			req.ContentLength = size
			if size == 0 {
				req.Body = http.NoBody
			}
		}
		resp, e := c.Do(req)
		if e != nil {
			return nil, 0, e
		}
		defer resp.Body.Close()
		b, e := io.ReadAll(resp.Body)
		return b, resp.StatusCode, e
	}
	if cmd == "tree" || cmd == "cat" {
		if len(args) != 1 && cmd == "tree" || len(args) != 2 && cmd == "cat" {
			return fmt.Errorf("expected tree [path]")
		}
		path := "/v0/trees/" + url.PathEscape(args[0])
		if cmd == "cat" {
			path += "/files/" + escapePath(args[1])
		}
		b, status, e := call("GET", path, nil, 0)
		if e != nil {
			return e
		}
		if status/100 != 2 {
			return fmt.Errorf("HTTP %d: %s", status, b)
		}
		_, e = out.Write(b)
		return e
	}
	f := flag.NewFlagSet(cmd, flag.ContinueOnError)
	depth := f.Int("fetch-depth", store.DefaultDepth, "maximum in-flight blob uploads")
	lineage := f.String("lineage", "", "lineage")
	dir := f.String("dir", "", "directory")
	parent := f.String("parent", "", "parent tree")
	if e := f.Parse(args); e != nil {
		return e
	}
	if *lineage == "" || *dir == "" || *depth < 1 {
		return fmt.Errorf("lineage and dir required")
	}
	q := objects.Request{Lineage: *lineage, ParentTree: *parent, Files: map[string]objects.File{}}
	paths := map[string]string{}
	e := filepath.WalkDir(*dir, func(path string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.Name() == ".git" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		rel, e := filepath.Rel(*dir, path)
		if e != nil {
			return e
		}
		rel = filepath.ToSlash(rel)
		if e = objects.Path(rel); e != nil {
			return e
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		mode := "100644"
		var reader io.Reader
		var file *os.File
		if info.Mode()&os.ModeSymlink != 0 {
			mode = "120000"
			target, e := os.Readlink(path)
			if e != nil {
				return e
			}
			reader = strings.NewReader(target)
		} else if info.Mode().IsRegular() {
			if info.Mode()&0111 != 0 {
				mode = "100755"
			}
			file, e = os.Open(path)
			if e != nil {
				return e
			}
			defer file.Close()
			reader = file
		} else {
			return fmt.Errorf("unsupported file: %s", rel)
		}
		h := sha256.New()
		n, e := io.Copy(h, io.LimitReader(reader, objects.MaxBlob+1))
		if e != nil {
			return e
		}
		if n > objects.MaxBlob {
			return fmt.Errorf("file too large: %s", rel)
		}
		hash := fmt.Sprintf("%x", h.Sum(nil))
		q.Files[rel] = objects.File{SHA256: hash, Mode: mode}
		paths[hash] = path
		return nil
	})
	if e != nil {
		return e
	}
	var uploaded atomic.Int64
	uploadTime := time.Duration(0)
	for {
		body, e := json.Marshal(q)
		if e != nil {
			return e
		}
		b, status, e := call("POST", "/v0/trees", bytes.NewReader(body), int64(len(body)))
		if e != nil {
			return e
		}
		if status/100 == 2 {
			var result map[string]any
			if e = json.Unmarshal(b, &result); e != nil {
				return e
			}
			result["uploadedBlobs"] = uploaded.Load()
			result["uploadMs"] = float64(uploadTime.Microseconds()) / 1000
			return json.NewEncoder(out).Encode(result)
		}
		var missing struct {
			Error   string   `json:"error"`
			Missing []string `json:"missing"`
		}
		if status != 409 || json.Unmarshal(b, &missing) != nil || missing.Error != "missing-blobs" || len(missing.Missing) == 0 {
			return fmt.Errorf("HTTP %d: %s", status, b)
		}
		start := time.Now()
		e = store.Parallel(context.Background(), *depth, missing.Missing, func(hash string) error {
			path, ok := paths[hash]
			if !ok {
				return fmt.Errorf("unknown missing blob")
			}
			info, e := os.Lstat(path)
			if e != nil {
				return e
			}
			var reader io.Reader
			var file *os.File
			size := info.Size()
			if info.Mode()&os.ModeSymlink != 0 {
				target, e := os.Readlink(path)
				if e != nil {
					return e
				}
				reader = strings.NewReader(target)
				size = int64(len(target))
			} else {
				file, e = os.Open(path)
				if e != nil {
					return e
				}
				defer file.Close()
				reader = file
			}
			b, status, e := call("PUT", "/v0/blobs/"+hash+"?lineage="+url.QueryEscape(*lineage), reader, size)
			if e != nil {
				return e
			}
			if status != 201 {
				return fmt.Errorf("HTTP %d: %s", status, b)
			}
			uploaded.Add(1)
			return nil
		})
		uploadTime += time.Since(start)
		if e != nil {
			return e
		}
	}
}
func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}
