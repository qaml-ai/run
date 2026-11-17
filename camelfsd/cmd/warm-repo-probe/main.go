// warm-repo-probe is an isolated read-only Git service experiment.
package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

type manifest struct {
	Lineage string          `json:"lineage"`
	Commit  string          `json:"commit"`
	Tree    string          `json:"tree"`
	Entries []objects.Entry `json:"entries"`
	Bytes   int64           `json:"bytes"`
}

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("choose seed, fill, serve, or client")
	}
	f := flag.NewFlagSet(args[0], flag.ContinueOnError)
	data := f.String("data", "", "private benchmark output directory")
	manifestPath := f.String("manifest", "", "trusted pinned fixture manifest")
	storeURL := f.String("store", "", "canonical source absolute path or S3 URL")
	region := f.String("region", "us-west-2", "canonical source region")
	table := f.String("objects-table", "", "canonical bundle locator table")
	mib := f.Int("mib", 50, "fixture size label (50 or 500)")
	listen := f.String("listen", "0.0.0.0:8080", "HTTP listen address")
	url := f.String("url", "", "selected remote warm service origin")
	trials := f.Int("trials", 3, "complete verified transfer trials")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	switch args[0] {
	case "seed":
		return seed(ctx, *data, *storeURL, *region, *table, *mib)
	case "fill":
		return fill(ctx, *data, *manifestPath, *storeURL, *region, *table)
	case "serve":
		if *mib == 0 {
			mux := http.NewServeMux()
			for _, size := range []string{"50", "500"} {
				m, err := readManifest(filepath.Join(*data, size, "manifest.json"))
				if err != nil {
					return err
				}
				s, err := newService(ctx, filepath.Join(*data, size, "repo.git"), m, os.Getenv("WARM_REPO_TOKEN"))
				if err != nil {
					return err
				}
				mux.Handle("/"+size+"/", http.StripPrefix("/"+size, s))
			}
			emit(map[string]any{"event": "warm_repo_pair_listen", "address": *listen})
			return (&http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}).ListenAndServe()
		}
		m, err := readManifest(filepath.Join(*data, "manifest.json"))
		if err != nil {
			return err
		}
		service, err := newService(ctx, filepath.Join(*data, "repo.git"), m, os.Getenv("WARM_REPO_TOKEN"))
		if err != nil {
			return err
		}
		emit(map[string]any{"event": "warm_repo_listen", "commit": m.Commit, "tree": m.Tree, "files": len(m.Entries), "bytes": m.Bytes})
		server := &http.Server{Addr: *listen, Handler: service, ReadHeaderTimeout: 10 * time.Second}
		return server.ListenAndServe()
	case "client":
		if *trials < 1 {
			return errors.New("trials must be positive")
		}
		var m manifest
		var err error
		if *manifestPath == "" {
			m, err = fetchManifest(ctx, *url, os.Getenv("WARM_REPO_TOKEN"))
		} else {
			m, err = readManifest(*manifestPath)
		}
		if err != nil {
			return err
		}
		return client(ctx, *url, m, os.Getenv("WARM_REPO_TOKEN"), *trials)
	default:
		return fmt.Errorf("unknown command %s", args[0])
	}
}

func emit(v any) { _ = json.NewEncoder(os.Stdout).Encode(v) }

func readManifest(path string) (manifest, error) {
	var m manifest
	raw, err := os.ReadFile(path)
	if err != nil {
		return m, err
	}
	if err = json.Unmarshal(raw, &m); err != nil {
		return m, err
	}
	if !root.Hex(m.Commit, 40) || !root.Hex(m.Tree, 40) || len(m.Entries) == 0 {
		return m, errors.New("invalid pinned manifest")
	}
	seen := make(map[string]bool)
	var total int64
	for _, e := range m.Entries {
		if objects.Path(e.Path) != nil || seen[e.Path] || !root.Hex(e.SHA1, 40) || e.Size < 0 ||
			(e.Mode != "100644" && e.Mode != "100755" && e.Mode != "120000") {
			return m, errors.New("invalid manifest entry")
		}
		seen[e.Path] = true
		total += e.Size
	}
	if m.Bytes != total {
		return m, errors.New("manifest byte count mismatch")
	}
	sort.Slice(m.Entries, func(i, j int) bool { return m.Entries[i].Path < m.Entries[j].Path })
	return m, nil
}

func git(ctx context.Context, repo string, input io.Reader, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--git-dir=" + repo}, args...)...)
	cmd.Stdin = input
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", args[0], err, &stderr)
	}
	return out, nil
}

type service struct {
	repo  string
	m     manifest
	files map[string]objects.Entry
	token string
}

func newService(ctx context.Context, repo string, m manifest, token string) (*service, error) {
	if token == "" {
		return nil, errors.New("WARM_REPO_TOKEN required")
	}
	value, err := git(ctx, repo, nil, "rev-parse", m.Commit+"^{tree}")
	if err != nil || strings.TrimSpace(string(value)) != m.Tree {
		return nil, fmt.Errorf("Git repository does not contain pinned commit/tree: %w", err)
	}
	// Rebuild the path index from actual Git objects on each service start.
	listing, err := git(ctx, repo, nil, "ls-tree", "-r", "-l", "-z", m.Tree)
	if err != nil {
		return nil, err
	}
	files := make(map[string]objects.Entry)
	for _, item := range bytes.Split(listing, []byte{0}) {
		if len(item) == 0 {
			continue
		}
		head, path, ok := strings.Cut(string(item), "\t")
		fields := strings.Fields(head)
		if !ok || len(fields) != 4 || fields[1] != "blob" {
			return nil, errors.New("unsupported Git tree entry")
		}
		size, err := strconv.ParseInt(fields[3], 10, 64)
		if err != nil {
			return nil, err
		}
		files[path] = objects.Entry{Path: path, Mode: fields[0], SHA1: fields[2], Size: size}
	}
	if len(files) != len(m.Entries) {
		return nil, errors.New("Git tree inventory mismatch")
	}
	for _, e := range m.Entries {
		if files[e.Path] != e {
			return nil, fmt.Errorf("Git tree mismatch for %q", e.Path)
		}
	}
	return &service{repo, m, files, token}, nil
}

func (s *service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	prefix := "/repos/" + s.m.Commit
	if r.URL.Path == "/manifest" || r.URL.Path == prefix+"/manifest" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.m)
		return
	}
	if r.URL.Path == prefix+"/snapshot" {
		w.Header().Set("Content-Type", "application/x-tar")
		w.Header().Set("X-CamelFS-Tree", s.m.Tree)
		if err := s.snapshot(r.Context(), w); err != nil {
			// Once bytes were sent, close the response abruptly. The client must
			// reject the incomplete snapshot, even if tar had ended early.
			fmt.Fprintln(os.Stderr, "snapshot failed:", err)
			panic(http.ErrAbortHandler)
		}
		return
	}
	path, ok := strings.CutPrefix(r.URL.Path, prefix+"/files/")
	e, found := s.files[path]
	if !ok || !found {
		http.Error(w, "pinned path missing", http.StatusNotFound)
		return
	}
	data, err := git(r.Context(), s.repo, nil, "cat-file", "blob", e.SHA1)
	if err != nil || int64(len(data)) != e.Size || blobID(e.Size, bytes.NewReader(data)) != e.SHA1 {
		http.Error(w, "Git object unavailable or corrupt", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Length", strconv.FormatInt(e.Size, 10))
	w.Header().Set("ETag", `"`+e.SHA1+`"`)
	_, _ = w.Write(data)
}

func (s *service) snapshot(ctx context.Context, w io.Writer) error {
	cmd := exec.CommandContext(ctx, "git", "--git-dir="+s.repo, "cat-file", "--batch")
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		return err
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	reader := bufio.NewReaderSize(out, 256<<10)
	tarWriter := tar.NewWriter(w)
	for _, e := range s.m.Entries {
		if _, err = fmt.Fprintln(in, e.SHA1); err != nil {
			return err
		}
		header, err := reader.ReadString('\n')
		if err != nil || header != fmt.Sprintf("%s blob %d\n", e.SHA1, e.Size) {
			return fmt.Errorf("invalid Git blob %s: %q %v", e.SHA1, header, err)
		}
		// The experiment uses regular fixture files. Symlinks are represented
		// as their exact Git blob bytes with the Git mode in the PAX record.
		if err = tarWriter.WriteHeader(&tar.Header{Name: e.Path, Mode: 0644, Size: e.Size,
			PAXRecords: map[string]string{"camelfs.mode": e.Mode}, Format: tar.FormatPAX}); err != nil {
			return err
		}
		if _, err = io.CopyN(tarWriter, reader, e.Size); err != nil {
			return err
		}
		if end, err := reader.ReadByte(); err != nil || end != '\n' {
			return errors.New("invalid Git batch terminator")
		}
	}
	if err = in.Close(); err != nil {
		return err
	}
	if err = cmd.Wait(); err != nil {
		return fmt.Errorf("Git batch failed: %w %s", err, &stderr)
	}
	return tarWriter.Close()
}

func blobID(size int64, r io.Reader) string {
	h := sha1.New()
	_, _ = fmt.Fprintf(h, "blob %d\x00", size)
	if _, err := io.Copy(h, r); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}
