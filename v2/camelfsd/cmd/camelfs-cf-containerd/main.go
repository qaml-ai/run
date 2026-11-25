package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/cfcontainer"
)

type httpBlobFetcher struct {
	baseURL string
	token   string
	client  *http.Client
}

func (f *httpBlobFetcher) FetchBlob(ctx context.Context, hash string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.baseURL+"/"+hash, nil)
	if err != nil {
		return nil, err
	}
	if f.token != "" {
		req.Header.Set("X-Camelfs-Internal-Token", f.token)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("blob fetch %s HTTP %d: %s", hash, resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return io.ReadAll(resp.Body)
}

type persistentShell struct {
	mu      sync.Mutex
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stdout  *bufio.Reader
	stderr  *bufio.Reader
	baseDir string
	initEnv map[string]string
}

func newPersistentShell(baseDir string, initEnv map[string]string) *persistentShell {
	return &persistentShell{baseDir: baseDir, initEnv: initEnv}
}

func (p *persistentShell) ensureStartedLocked() error {
	if p.cmd != nil && p.cmd.Process != nil {
		return nil
	}
	cmd := exec.Command("bash", "--noprofile", "--norc")
	cmd.Dir = p.baseDir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	env := append([]string(nil), os.Environ()...)
	env = append(env, "HOME="+p.baseDir)
	for k, v := range p.initEnv {
		env = append(env, k+"="+v)
	}
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	p.cmd = cmd
	p.stdin = stdin
	p.stdout = bufio.NewReader(stdoutPipe)
	p.stderr = bufio.NewReader(stderrPipe)
	return nil
}

func (p *persistentShell) killLocked() {
	if p.cmd != nil && p.cmd.Process != nil {
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
		_, _ = p.cmd.Process.Wait()
	}
	p.cmd = nil
	p.stdin = nil
	p.stdout = nil
	p.stderr = nil
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type execResp struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	Cwd      string `json:"cwd"`
	TimedOut bool   `json:"timedOut"`
}

func (p *persistentShell) Exec(ctx context.Context, command, cwd string, extraEnv map[string]string, timeoutS int) (*execResp, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.ensureStartedLocked(); err != nil {
		return nil, err
	}
	if timeoutS <= 0 {
		timeoutS = 60
	}
	sentinel := "__CAMELFS_DONE_" + randHex(8) + "__"
	var script strings.Builder
	if cwd != "" {
		targetDir := cwd
		if cwd == "/workspace" {
			targetDir = p.baseDir
		} else if strings.HasPrefix(cwd, "/workspace/") {
			targetDir = filepath.Join(p.baseDir, strings.TrimPrefix(cwd, "/workspace/"))
		}
		fmt.Fprintf(&script, "cd %q\n", targetDir)
	}
	for k, v := range extraEnv {
		fmt.Fprintf(&script, "export %s=%q\n", k, v)
	}
	script.WriteString(command)
	if !strings.HasSuffix(command, "\n") {
		script.WriteString("\n")
	}
	fmt.Fprintf(&script, "__cf_rc=$?\nprintf '\\n%s:%%s:%%s\\n' \"$__cf_rc\" \"$PWD\"\nprintf '%s\\n' >&2\n", sentinel, sentinel)

	if _, err := io.WriteString(p.stdin, script.String()); err != nil {
		p.killLocked()
		return nil, fmt.Errorf("write shell stdin: %w", err)
	}

	type readOut struct {
		text     string
		exitCode int
		cwd      string
		err      error
	}
	outCh := make(chan readOut, 1)
	errCh := make(chan readOut, 1)

	go func() {
		var buf strings.Builder
		prefix := sentinel + ":"
		for {
			line, err := p.stdout.ReadString('\n')
			if err != nil {
				outCh <- readOut{text: buf.String(), err: err}
				return
			}
			if strings.HasPrefix(line, prefix) {
				parts := strings.SplitN(strings.TrimSpace(strings.TrimPrefix(line, prefix)), ":", 2)
				rc := 0
				cwdOut := p.baseDir
				if len(parts) >= 1 {
					rc, _ = strconv.Atoi(parts[0])
				}
				if len(parts) == 2 {
					cwdOut = parts[1]
				}
				txt := buf.String()
				if strings.HasSuffix(txt, "\n") && !strings.HasSuffix(txt, "\n\n") {
					// Strip the synthetic leading newline added before the sentinel when stdout had output.
				}
				txt = strings.TrimSuffix(txt, "\n")
				outCh <- readOut{text: txt, exitCode: rc, cwd: cwdOut}
				return
			}
			buf.WriteString(line)
		}
	}()

	go func() {
		var buf strings.Builder
		for {
			line, err := p.stderr.ReadString('\n')
			if err != nil {
				errCh <- readOut{text: buf.String(), err: err}
				return
			}
			if strings.TrimSpace(line) == sentinel {
				errCh <- readOut{text: buf.String()}
				return
			}
			buf.WriteString(line)
		}
	}()

	timer := time.NewTimer(time.Duration(timeoutS) * time.Second)
	defer timer.Stop()

	var so, se readOut
	gotOut, gotErr := false, false
	for !(gotOut && gotErr) {
		select {
		case so = <-outCh:
			gotOut = true
		case se = <-errCh:
			gotErr = true
		case <-timer.C:
			p.killLocked()
			return &execResp{ExitCode: 124, Stdout: so.text, Stderr: se.text, Cwd: "/workspace", TimedOut: true}, nil
		case <-ctx.Done():
			p.killLocked()
			return nil, ctx.Err()
		}
	}
	if so.err != nil {
		p.killLocked()
		return nil, so.err
	}

	reportedCwd := "/workspace"
	if rel, err := filepath.Rel(p.baseDir, so.cwd); err == nil && !strings.HasPrefix(rel, "..") {
		if rel == "." || rel == "" {
			reportedCwd = "/workspace"
		} else {
			reportedCwd = "/workspace/" + filepath.ToSlash(rel)
		}
	} else {
		reportedCwd = so.cwd
	}
	return &execResp{
		ExitCode: so.exitCode,
		Stdout:   so.text,
		Stderr:   se.text,
		Cwd:      reportedCwd,
		TimedOut: false,
	}, nil
}

type vmSession struct {
	mu       sync.Mutex
	vmID     string
	baseDir  string
	mountDir string
	fuse     *cfcontainer.MountSession
	shell    *persistentShell
}

type daemonServer struct {
	rootDir  string
	mu       sync.RWMutex
	sessions map[string]*vmSession
	httpCli  *http.Client
}

func newDaemonServer(rootDir string) *daemonServer {
	return &daemonServer{
		rootDir:  rootDir,
		sessions: make(map[string]*vmSession),
		httpCli: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        64,
				MaxIdleConnsPerHost: 32,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func (d *daemonServer) getSession(vmID string) (*vmSession, bool) {
	d.mu.RLock()
	s, ok := d.sessions[vmID]
	d.mu.RUnlock()
	return s, ok
}

func (d *daemonServer) handleProbe(w http.ResponseWriter, _ *http.Request) {
	_, fuseErr := os.Stat("/dev/fuse")
	fm3, _ := exec.LookPath("fusermount3")
	fm, _ := exec.LookPath("fusermount")
	ovFS := false
	if raw, err := os.ReadFile("/proc/filesystems"); err == nil {
		ovFS = strings.Contains(string(raw), "overlay")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"uid":              os.Getuid(),
		"gid":              os.Getgid(),
		"devFusePresent":   fuseErr == nil,
		"fusermount3Path":  fm3,
		"fusermountPath":   fm,
		"kernelOverlayfs":  ovFS,
		"cowFuseSupported": fuseErr == nil && (fm3 != "" || fm != "" || os.Getuid() == 0),
	})
}

func (d *daemonServer) handleMount(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VMID          string                  `json:"vmId"`
		Tree          []cfcontainer.TreeEntry `json:"tree"`
		Env           map[string]string       `json:"env"`
		BlobBaseURL   string                  `json:"blobBaseUrl"`
		InternalToken string                  `json:"internalToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if req.VMID == "" {
		req.VMID = r.Header.Get("X-Camel-Vm-Id")
	}
	if req.VMID == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "vmId is required")
		return
	}

	baseDir := filepath.Join(d.rootDir, req.VMID)
	stateDir := filepath.Join(baseDir, "state")
	mountDir := filepath.Join(baseDir, "workspace")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}

	fetcher := &httpBlobFetcher{
		baseURL: strings.TrimRight(req.BlobBaseURL, "/"),
		token:   req.InternalToken,
		client:  d.httpCli,
	}
	mnt, err := cfcontainer.MountBest(context.Background(), req.Tree, fetcher, stateDir, mountDir)
	if err != nil {
		_ = os.RemoveAll(baseDir)
		writeErr(w, http.StatusInternalServerError, "fuse_mount_failed", err.Error())
		return
	}

	sess := &vmSession{
		vmID:     req.VMID,
		baseDir:  baseDir,
		mountDir: mountDir,
		fuse:     mnt,
		shell:    newPersistentShell(mountDir, req.Env),
	}
	d.mu.Lock()
	d.sessions[req.VMID] = sess
	d.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"vmId":     req.VMID,
		"mountDir": mountDir,
		"fsMode":   mnt.ModeName(),
		"stats":    mnt.Server.Stats(),
	})
}

func (d *daemonServer) handleExec(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VMID     string            `json:"vmId"`
		Command  string            `json:"command"`
		Cwd      string            `json:"cwd"`
		Env      map[string]string `json:"env"`
		TimeoutS int               `json:"timeoutS"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	sess, ok := d.getSession(req.VMID)
	if !ok {
		writeErr(w, http.StatusGone, "vm_lost", "vm session not found")
		return
	}
	res, err := sess.shell.Exec(r.Context(), req.Command, req.Cwd, req.Env, req.TimeoutS)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "exec_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (d *daemonServer) handleCollectDelta(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VMID string `json:"vmId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	sess, ok := d.getSession(req.VMID)
	if !ok {
		writeErr(w, http.StatusGone, "vm_lost", "vm session not found")
		return
	}
	delta, err := sess.fuse.CollectDelta()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "delta_failed", err.Error())
		return
	}
	type wirePut struct {
		Path       string `json:"path"`
		Mode       uint32 `json:"mode"`
		Base64     string `json:"base64,omitempty"`
		LinkTarget string `json:"linkTarget,omitempty"`
	}
	puts := make([]wirePut, 0, len(delta.Puts))
	for _, p := range delta.Puts {
		mode := uint32(0o644)
		if p.Mode&cfcontainer.S_IFMT == cfcontainer.S_IFLNK {
			mode = 0o777
		} else if p.Mode&0o111 != 0 {
			mode = 0o755
		}
		puts = append(puts, wirePut{
			Path:       p.Path,
			Mode:       mode,
			Base64:     base64.StdEncoding.EncodeToString(p.Data),
			LinkTarget: p.LinkTarget,
		})
	}
	deletes := delta.Deletes
	if deletes == nil {
		deletes = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"puts":    puts,
		"deletes": deletes,
	})
}

func (d *daemonServer) handleApplyOps(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VMID string `json:"vmId"`
		Ops  []struct {
			Kind   string `json:"kind"`
			Path   string `json:"path"`
			From   string `json:"from"`
			Mode   uint32 `json:"mode"`
			Base64 string `json:"base64"`
		} `json:"ops"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	sess, ok := d.getSession(req.VMID)
	if !ok {
		writeErr(w, http.StatusGone, "vm_lost", "vm session not found")
		return
	}
	ops := make([]cfcontainer.LiveOp, 0, len(req.Ops))
	for _, op := range req.Ops {
		var data []byte
		if op.Base64 != "" {
			var err error
			data, err = base64.StdEncoding.DecodeString(op.Base64)
			if err != nil {
				writeErr(w, http.StatusBadRequest, "invalid_request", err.Error())
				return
			}
		}
		ops = append(ops, cfcontainer.LiveOp{
			Kind: op.Kind,
			Path: op.Path,
			From: op.From,
			Mode: op.Mode,
			Data: data,
		})
	}
	if err := sess.fuse.ApplyOps(ops); err != nil {
		writeErr(w, http.StatusInternalServerError, "apply_ops_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (d *daemonServer) handleReadFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VMID   string `json:"vmId"`
		Path   string `json:"path"`
		Offset int64  `json:"offset"`
		Limit  int64  `json:"limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	sess, ok := d.getSession(req.VMID)
	if !ok {
		writeErr(w, http.StatusGone, "vm_lost", "vm session not found")
		return
	}
	clean := strings.Trim(path.Clean(req.Path), "/")
	fp := filepath.Join(sess.mountDir, filepath.FromSlash(clean))
	info, err := os.Stat(fp)
	if err != nil {
		if os.IsNotExist(err) {
			writeErr(w, http.StatusNotFound, "not_found", fmt.Sprintf("path %q not found", clean))
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	data, err := os.ReadFile(fp)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	fullSize := int64(len(data))
	start := req.Offset
	if start < 0 {
		start = 0
	}
	if start > fullSize {
		start = fullSize
	}
	end := fullSize
	if req.Limit > 0 && start+req.Limit < end {
		end = start + req.Limit
	}
	slice := data[start:end]
	bin := bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0
	resp := map[string]any{
		"commit": "",
		"path":   clean,
		"size":   fullSize,
		"mode":   int(info.Mode().Perm()),
		"binary": bin,
	}
	if bin {
		resp["content"] = nil
		resp["base64"] = base64.StdEncoding.EncodeToString(slice)
	} else {
		resp["content"] = string(slice)
		resp["base64"] = nil
	}
	writeJSON(w, http.StatusOK, resp)
}

func (d *daemonServer) handleListFiles(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VMID      string `json:"vmId"`
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
		Glob      string `json:"glob"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	sess, ok := d.getSession(req.VMID)
	if !ok {
		writeErr(w, http.StatusGone, "vm_lost", "vm session not found")
		return
	}
	type entry struct {
		Path string `json:"path"`
		Type string `json:"type"`
		Size int64  `json:"size"`
		Mode int    `json:"mode"`
		Hash string `json:"hash"`
	}
	entries := []entry{}
	baseDir := sess.mountDir
	prefix := strings.Trim(path.Clean(req.Path), "/")
	if prefix == "." {
		prefix = ""
	}
	walkRoot := baseDir
	if prefix != "" {
		walkRoot = filepath.Join(baseDir, filepath.FromSlash(prefix))
	}
	_ = filepath.WalkDir(walkRoot, func(fp string, de fs.DirEntry, err error) error {
		if err != nil || fp == walkRoot {
			return nil
		}
		rel, err := filepath.Rel(baseDir, fp)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if !req.Recursive && de.IsDir() {
			entries = append(entries, entry{Path: rel, Type: "dir", Mode: 0o755})
			return filepath.SkipDir
		}
		if de.IsDir() {
			return nil
		}
		info, err := de.Info()
		if err != nil {
			return nil
		}
		entries = append(entries, entry{
			Path: rel,
			Type: "file",
			Size: info.Size(),
			Mode: int(info.Mode().Perm()),
		})
		return nil
	})
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (d *daemonServer) handleGrepFiles(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VMID       string `json:"vmId"`
		Pattern    string `json:"pattern"`
		Path       string `json:"path"`
		MaxMatches int    `json:"maxMatches"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	sess, ok := d.getSession(req.VMID)
	if !ok {
		writeErr(w, http.StatusGone, "vm_lost", "vm session not found")
		return
	}
	re, err := regexp.Compile(req.Pattern)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	maxMatches := req.MaxMatches
	if maxMatches <= 0 {
		maxMatches = 100
	}
	type match struct {
		Path   string `json:"path"`
		Line   int    `json:"line"`
		Column int    `json:"column"`
		Text   string `json:"text"`
	}
	matches := []match{}
	_ = filepath.WalkDir(sess.mountDir, func(fp string, de fs.DirEntry, err error) error {
		if err != nil || de.IsDir() || len(matches) >= maxMatches {
			return nil
		}
		rel, err := filepath.Rel(sess.mountDir, fp)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if req.Path != "" && !strings.HasPrefix(rel, strings.TrimLeft(req.Path, "/")) {
			return nil
		}
		data, err := os.ReadFile(fp)
		if err != nil || bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
			return nil
		}
		for idx, line := range strings.Split(string(data), "\n") {
			clean := strings.TrimSuffix(line, "\r")
			if loc := re.FindStringIndex(clean); loc != nil {
				matches = append(matches, match{Path: rel, Line: idx + 1, Column: loc[0] + 1, Text: clean})
				if len(matches) >= maxMatches {
					return io.EOF
				}
			}
		}
		return nil
	})
	writeJSON(w, http.StatusOK, map[string]any{"matches": matches})
}

func (d *daemonServer) handleStats(w http.ResponseWriter, r *http.Request) {
	vmID := r.URL.Query().Get("vmId")
	sess, ok := d.getSession(vmID)
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "vm session not found")
		return
	}
	writeJSON(w, http.StatusOK, sess.fuse.Server.Stats())
}

func (d *daemonServer) handleUnmount(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VMID string `json:"vmId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	d.mu.Lock()
	sess, ok := d.sessions[req.VMID]
	delete(d.sessions, req.VMID)
	d.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	sess.shell.mu.Lock()
	sess.shell.killLocked()
	sess.shell.mu.Unlock()
	_ = sess.fuse.Close()
	_ = os.RemoveAll(sess.baseDir)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func main() {
	listen := flag.String("listen", ":8080", "HTTP listen address")
	dataDir := flag.String("data-dir", "", "Scratch directory for mounted VM sessions")
	flag.Parse()

	rootDir := *dataDir
	if rootDir == "" {
		var err error
		rootDir, err = os.MkdirTemp("", "camelfs-cf-containerd-*")
		if err != nil {
			log.Fatalf("mkdirtemp: %v", err)
		}
		defer os.RemoveAll(rootDir)
	}
	srv := newDaemonServer(rootDir)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /probe", srv.handleProbe)
	mux.HandleFunc("POST /mount", srv.handleMount)
	mux.HandleFunc("POST /exec", srv.handleExec)
	mux.HandleFunc("POST /collect_delta", srv.handleCollectDelta)
	mux.HandleFunc("POST /apply_ops", srv.handleApplyOps)
	mux.HandleFunc("POST /read_file", srv.handleReadFile)
	mux.HandleFunc("POST /list_files", srv.handleListFiles)
	mux.HandleFunc("POST /grep_files", srv.handleGrepFiles)
	mux.HandleFunc("GET /stats", srv.handleStats)
	mux.HandleFunc("POST /unmount", srv.handleUnmount)

	httpSrv := &http.Server{Addr: *listen, Handler: mux}
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		srv.mu.Lock()
		all := make([]*vmSession, 0, len(srv.sessions))
		for id, s := range srv.sessions {
			all = append(all, s)
			delete(srv.sessions, id)
		}
		srv.mu.Unlock()
		for _, s := range all {
			s.shell.mu.Lock()
			s.shell.killLocked()
			s.shell.mu.Unlock()
			_ = s.fuse.Close()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(ctx)
	}()

	log.Printf("camelfs-cf-containerd listening on %s (root=%s)", *listen, rootDir)
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
