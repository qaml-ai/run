package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
)

func request(ctx context.Context, httpClient *http.Client, origin, path, token string) (*http.Response, error) {
	if token == "" {
		return nil, errors.New("WARM_REPO_TOKEN required")
	}
	if u, err := url.Parse(origin); err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("explicit HTTP(S) origin required")
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(origin, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set("Authorization", "Bearer "+token)
	response, err := httpClient.Do(r)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		_ = response.Body.Close()
		return nil, fmt.Errorf("warm service %s returned HTTP %d", path, response.StatusCode)
	}
	return response, nil
}

func fetchManifest(ctx context.Context, origin, token string) (manifest, error) {
	response, err := request(ctx, &http.Client{Timeout: 20 * time.Second}, origin, "/manifest", token)
	if err != nil {
		return manifest{}, err
	}
	defer response.Body.Close()
	var m manifest
	err = json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(&m)
	return m, err
}

func client(ctx context.Context, origin string, m manifest, token string, trials int) error {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	httpClient := &http.Client{Transport: transport, Timeout: 3 * time.Minute}
	defer transport.CloseIdleConnections()
	prefix := "/repos/" + m.Commit
	var first objects.Entry
	for _, e := range m.Entries {
		if e.Path == "src/d000/f00000.ts" {
			first = e
		}
	}
	if first.Path == "" {
		return errors.New("fixture first-file marker missing")
	}
	// This is an API path read, including authorization, pinned lookup, Git
	// read, HTTP transfer, and client hash verification.
	var latencies []float64
	for i := range 32 {
		start := time.Now()
		var connected string
		trace := &httptrace.ClientTrace{GotConn: func(v httptrace.GotConnInfo) { connected = v.Conn.RemoteAddr().String() }}
		callCtx := httptrace.WithClientTrace(ctx, trace)
		response, err := request(callCtx, httpClient, origin, prefix+"/files/"+first.Path, token)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, first.Size+1))
		err = errors.Join(err, response.Body.Close())
		if err != nil || int64(len(data)) != first.Size || blobID(first.Size, bytes.NewReader(data)) != first.SHA1 {
			return fmt.Errorf("first-file verification failed: %v", err)
		}
		ms := time.Since(start).Seconds() * 1000
		latencies = append(latencies, ms)
		if i == 0 {
			emit(map[string]any{"event": "warm_repo_remote_first_file", "origin": origin, "peer": connected,
				"commit": m.Commit, "tree": m.Tree, "path": first.Path, "gitSHA1": first.SHA1, "bytes": first.Size, "ms": ms})
		}
	}
	sort.Float64s(latencies)
	emit(map[string]any{"event": "warm_repo_remote_api", "origin": origin, "calls": len(latencies),
		"p50Ms": latencies[len(latencies)/2], "p95Ms": latencies[len(latencies)*95/100]})
	for trial := 1; trial <= trials; trial++ {
		start := time.Now()
		response, err := request(ctx, httpClient, origin, prefix+"/snapshot", token)
		if err != nil {
			return err
		}
		if response.Header.Get("X-CamelFS-Tree") != m.Tree {
			_ = response.Body.Close()
			return errors.New("snapshot tree header mismatch")
		}
		firstMs, err := verifySnapshot(response.Body, m, start)
		err = errors.Join(err, response.Body.Close())
		if err != nil {
			return err
		}
		emit(map[string]any{"event": "warm_repo_remote_snapshot", "origin": origin, "trial": trial,
			"commit": m.Commit, "tree": m.Tree, "files": len(m.Entries), "bytes": m.Bytes,
			"firstEntryMs": firstMs, "firstEntryPath": m.Entries[0].Path, "ms": time.Since(start).Seconds() * 1000})
	}
	return nil
}

func verifySnapshot(r io.Reader, m manifest, start time.Time) (float64, error) {
	expected := make(map[string]objects.Entry, len(m.Entries))
	for _, e := range m.Entries {
		expected[e.Path] = e
	}
	reader := tar.NewReader(r)
	var firstMs float64
	var total int64
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, err
		}
		e, ok := expected[header.Name]
		if !ok || header.Typeflag != tar.TypeReg || header.Size != e.Size || header.PAXRecords["camelfs.mode"] != e.Mode {
			return 0, errors.New("unexpected snapshot entry")
		}
		if blobID(e.Size, reader) != e.SHA1 {
			return 0, fmt.Errorf("snapshot digest mismatch at %s", e.Path)
		}
		if firstMs == 0 {
			firstMs = time.Since(start).Seconds() * 1000
		}
		total += e.Size
		delete(expected, e.Path)
	}
	if len(expected) != 0 || total != m.Bytes {
		return 0, errors.New("incomplete snapshot")
	}
	// Reach HTTP EOF as well as tar EOF so a failed final HTTP chunk is loud.
	if _, err := io.Copy(io.Discard, r); err != nil {
		return 0, err
	}
	return firstMs, nil
}
