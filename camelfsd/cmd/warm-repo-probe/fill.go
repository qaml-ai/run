package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func openStore(ctx context.Context, url, region, table string) (store.Store, error) {
	s, err := store.Open(ctx, url, region, 64)
	if err != nil || table == "" {
		return s, err
	}
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, err
	}
	return store.WithBundles(s, dynamodb.NewFromConfig(cfg), table), nil
}

func seed(ctx context.Context, data, url, region, table string, mib int) error {
	if data == "" || (mib != 50 && mib != 500) {
		return errors.New("seed requires --data and --mib=50 or 500")
	}
	if err := os.Mkdir(data, 0700); err != nil {
		return err
	}
	if url == "" {
		url = filepath.Join(data, "canonical")
	}
	s, err := openStore(ctx, url, region, table)
	if err != nil {
		return err
	}
	db, err := refs.OpenStorage(filepath.Join(data, "seed.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	repo := &objects.Repository{DB: db, Store: s, TempDir: data}
	lineage := fmt.Sprintf("warmrepo-%d-%d", mib, time.Now().UnixNano())
	files := make(map[string]objects.File)
	batch := repo.ForLineage(lineage).BeginPublication()
	start := time.Now()
	for i := range 10000 {
		raw := make([]byte, 4096)
		if _, err := rand.Read(raw); err != nil {
			return err
		}
		batch.StageBlob(raw)
		files[fmt.Sprintf("src/d%03d/f%05d.ts", i/100, i)] = objects.File{SHA256: root.Hash(raw)}
	}
	if err = batch.Flush(ctx); err != nil {
		return err
	}
	var mu sync.Mutex
	paths := make([]string, mib-40)
	for i := range paths {
		paths[i] = fmt.Sprintf("assets/a%04d.bin", i)
	}
	if err = store.Parallel(ctx, 8, paths, func(path string) error {
		raw := make([]byte, 1<<20)
		if _, err := rand.Read(raw); err != nil {
			return err
		}
		b, err := repo.Upload(ctx, lineage, root.Hash(raw), int64(len(raw)), bytes.NewReader(raw))
		if err != nil {
			return err
		}
		mu.Lock()
		files[path] = objects.File{SHA256: b.SHA256}
		mu.Unlock()
		return nil
	}); err != nil {
		return err
	}
	result, err := repo.Import(ctx, objects.Request{Lineage: lineage, Files: files})
	if err != nil {
		return err
	}
	rawCommit := []byte("tree " + result.Tree + "\nauthor probe <probe@localhost> 1 +0000\ncommitter probe <probe@localhost> 1 +0000\n\nsynthetic fixture\n")
	commit, err := repo.PutObject(ctx, lineage, "commit", rawCommit)
	if err != nil {
		return err
	}
	entries, err := repo.ForLineage(lineage).TreeEntries(ctx, result.Tree)
	if err != nil {
		return err
	}
	m := manifest{Lineage: lineage, Commit: commit, Tree: result.Tree, Entries: entries}
	for _, e := range entries {
		m.Bytes += e.Size
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(data, "manifest.json"), raw, 0600); err != nil {
		return err
	}
	emit(map[string]any{"event": "warm_repo_seed", "source": url, "lineage": lineage, "commit": commit,
		"tree": result.Tree, "files": len(entries), "bytes": m.Bytes, "ms": time.Since(start).Seconds() * 1000})
	return nil
}

func fill(ctx context.Context, data, manifestPath, url, region, table string) error {
	m, err := readManifest(manifestPath)
	if err != nil {
		return err
	}
	if data == "" || url == "" {
		return errors.New("fill requires --data and --store")
	}
	if err = os.Mkdir(data, 0700); err != nil {
		return err
	}
	s, err := openStore(ctx, url, region, table)
	if err != nil {
		return err
	}
	start := time.Now()
	db, err := refs.OpenStorage(filepath.Join(data, "source.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	repo := (&objects.Repository{DB: db, Store: s, TempDir: data}).ForLineage(m.Lineage)
	commit, found, err := repo.CommitAncestry(ctx, m.Lineage, m.Commit)
	if err != nil || !found || commit.Tree != m.Tree {
		return fmt.Errorf("source commit/tree mismatch: %v", err)
	}
	entries, err := repo.TreeEntries(ctx, m.Tree)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(entries, m.Entries) {
		return errors.New("canonical tree inventory differs from pinned manifest")
	}
	var ids []string
	for _, e := range entries {
		if e.Size <= store.BundleMaxBlob {
			ids = append(ids, e.SHA1)
		}
	}
	locs, err := store.LocateBundlesForRestore(ctx, repo.Store, ids)
	if err != nil {
		return err
	}
	packs := make(map[string]store.BundleRef)
	for _, loc := range locs {
		packs[loc.Key] = loc
	}
	packData := make(map[string][]byte)
	var packKeys []string
	for k := range packs {
		packKeys = append(packKeys, k)
	}
	var mu sync.Mutex
	if err = store.Parallel(ctx, 8, packKeys, func(key string) error {
		b, err := store.ReadBundle(ctx, repo.Store, key, packs[key].PackSize)
		if err != nil {
			return err
		}
		mu.Lock()
		packData[key] = b
		mu.Unlock()
		return nil
	}); err != nil {
		return err
	}
	metadataMs := time.Since(start).Seconds() * 1000
	gitDir := filepath.Join(data, "repo.git")
	if _, err = git(ctx, gitDir, nil, "init", "--bare", "--quiet", gitDir); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "git", "--git-dir="+gitDir, "fast-import", "--quiet", "--done")
	pipe, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		return err
	}
	defer func() { _ = pipe.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	w := bufio.NewWriterSize(pipe, 256<<10)
	_, err = fmt.Fprint(w, "commit refs/warm/fill\ncommitter probe <probe@localhost> 1 +0000\ndata 4\nfill\n")
	if err != nil {
		return err
	}
	// Serialize Git writes while bounded workers verify source bytes ahead.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type fetched struct {
		entry objects.Entry
		data  []byte
		file  *os.File
	}
	ready := make(chan fetched, 8)
	done := make(chan error, 1)
	paths := make([]string, len(entries))
	byPath := make(map[string]objects.Entry, len(entries))
	for i, e := range entries {
		paths[i], byPath[e.Path] = e.Path, e
	}
	go func() {
		defer close(ready)
		done <- store.Parallel(ctx, 8, paths, func(path string) error {
			e := byPath[path]
			v := fetched{entry: e}
			if loc, ok := locs[e.SHA1]; ok {
				b := packData[loc.Key]
				v.data = b[loc.Offset : loc.Offset+loc.Size]
				if loc.Size != e.Size || root.Hash(v.data) != loc.SHA256 || store.GitHash("blob", v.data) != e.SHA1 {
					return errors.New("bundle member mismatch")
				}
			} else {
				// Existing verified file-backed reads bound even a 5 GiB blob.
				var err error
				v.file, err = store.OpenVerifiedBlobFile(ctx, repo.Store, data, e.SHA1, e.Size)
				if err != nil {
					return err
				}
			}
			select {
			case ready <- v:
				return nil
			case <-ctx.Done():
				if v.file != nil {
					_ = v.file.Close()
				}
				return ctx.Err()
			}
		})
	}()
	defer func() {
		cancel()
		for v := range ready {
			if v.file != nil {
				_ = v.file.Close()
			}
		}
	}()
	for v := range ready {
		_, err = fmt.Fprintf(w, "M %s inline %s\ndata %d\n", v.entry.Mode, quoteGitPath(v.entry.Path), v.entry.Size)
		var reader io.Reader = bytes.NewReader(v.data)
		if v.file != nil {
			reader = v.file
		}
		if err == nil {
			_, err = io.CopyN(w, reader, v.entry.Size)
		}
		if v.file != nil {
			err = errors.Join(err, v.file.Close())
		}
		if err == nil {
			_, err = w.WriteString("\n")
		}
		if err != nil {
			return err
		}
	}
	if err = <-done; err != nil {
		return err
	}
	_, err = w.WriteString("\ndone\n")
	if err = errors.Join(err, w.Flush(), pipe.Close()); err != nil {
		return err
	}
	if err = cmd.Wait(); err != nil {
		return fmt.Errorf("fast-import: %w %s", err, &stderr)
	}
	actual, err := git(ctx, gitDir, nil, "rev-parse", "refs/warm/fill^{tree}")
	if err != nil || strings.TrimSpace(string(actual)) != m.Tree {
		return fmt.Errorf("hydrated Git tree mismatch: got %s: %v", actual, err)
	}
	commitBytes, err := repo.Object(ctx, m.Commit, "commit")
	if err != nil {
		return err
	}
	actual, err = git(ctx, gitDir, bytes.NewReader(commitBytes), "hash-object", "-w", "--stdin", "-t", "commit")
	if err != nil || strings.TrimSpace(string(actual)) != m.Commit {
		return fmt.Errorf("hydrated commit mismatch: %v", err)
	}
	if _, err = git(ctx, gitDir, nil, "update-ref", "refs/warm/pinned", m.Commit); err != nil {
		return err
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(data, "manifest.json"), raw, 0600); err != nil {
		return err
	}
	emit(map[string]any{"event": "warm_repo_fill", "source": url, "lineage": m.Lineage, "commit": m.Commit,
		"tree": m.Tree, "files": len(entries), "bytes": m.Bytes, "packs": len(packs),
		"metadataAndPacksMs": metadataMs, "ms": time.Since(start).Seconds() * 1000})
	return nil
}

// Git's C-style path quoting accepts three-digit octal byte escapes. Go's
// string quoting can emit hexadecimal or Unicode escapes that Git does not use.
func quoteGitPath(path string) string {
	var quoted strings.Builder
	quoted.WriteByte('"')
	for i := range len(path) {
		value := path[i]
		switch {
		case value == '\\' || value == '"':
			quoted.WriteByte('\\')
			quoted.WriteByte(value)
		case value < 0x20 || value >= 0x7f:
			fmt.Fprintf(&quoted, "\\%03o", value)
		default:
			quoted.WriteByte(value)
		}
	}
	quoted.WriteByte('"')
	return quoted.String()
}
