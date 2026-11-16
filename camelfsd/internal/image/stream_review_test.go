package image

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

func TestPreparedReceiveNeedsNoDatabaseOrStore(t *testing.T) {
	m, tree := unit3(t)
	b := []byte("base")
	sha := root.Hash(b)
	if _, e := m.objects("l").Upload(context.Background(), "l", sha, int64(len(b)), bytes.NewReader(b)); e != nil {
		t.Fatal(e)
	}
	tr, e := m.objects("l").Import(context.Background(), objects.Request{Lineage: "l", ParentTree: tree, Files: map[string]objects.File{"base": {SHA256: sha}}})
	if e != nil {
		t.Fatal(e)
	}
	v, e := m.Mount(t.Context(), Request{JobID: "prepared", Lineage: "l", Tree: tr.Tree, Parent: strings.Repeat("a", 40), Fence: &refs.Fence{Holder: "runtime", Epoch: 1}})
	if e != nil {
		t.Fatal(e)
	}
	base, e := m.prepareReceive(context.Background(), v)
	if e != nil {
		t.Fatal(e)
	}
	// All base loading and quota queries are finished before ready. Receiving
	// unchanged entries must work even with the repository unavailable.
	db := m.Refs
	m.Refs = nil
	defer func() { m.Refs = db }()
	var buf bytes.Buffer
	wire.Send(&buf, wire.Header{V: 1, Kind: "checkpoint", JobID: v.JobID, BaseTree: tr.Tree})
	wire.Send(&buf, wire.Op{End: true})
	a, bconn := net.Pipe()
	defer a.Close()
	go func() { io.Copy(bconn, &buf); bconn.Close() }()
	r, e := m.receive(context.Background(), v, a, base)
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(r.dir)
	if len(r.files) != 1 {
		t.Fatal(r.files)
	}
}
func TestReceiveDoesNotSyncBeforeAck(t *testing.T) {
	// Guard the latency contract, including both file and directory fsync.
	f, e := parser.ParseFile(token.NewFileSet(), "streams.go", nil, 0)
	if e != nil {
		t.Fatal(e)
	}
	for _, d := range f.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "receive" {
			continue
		}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Sync" {
					t.Error("receive must validate without fsync")
				}
			}
			return true
		})
	}
}
func TestIndexPackedWithinFrameLimit(t *testing.T) {
	entries := make([]objects.Entry, 5000)
	for i := range entries {
		entries[i] = objects.Entry{Path: fmt.Sprintf("src/file%05d", i), Mode: "100644", SHA1: fmt.Sprintf("%040d", i), Size: 1}
	}
	var b bytes.Buffer
	if e := sendIndex(&b, entries); e != nil {
		t.Fatal(e)
	}
	count, frames := 0, 0
	for b.Len() > 0 {
		p, e := wire.Read(&b, wire.JSONMax)
		if e != nil {
			t.Fatal(e)
		}
		var v struct {
			Index []objects.Entry `json:"index"`
		}
		if e = json.Unmarshal(p, &v); e != nil {
			t.Fatal(e)
		}
		count += len(v.Index)
		frames++
	}
	if count != 5000 || frames >= 20 {
		t.Fatal(count, frames)
	}
}

type applyStoreStub struct {
	store.Store
	open func(context.Context, string) (io.ReadCloser, error)
}

func (s applyStoreStub) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	return s.open(ctx, key)
}

func readApplyOp(t *testing.T, r io.Reader, want wire.Op, contents string) {
	t.Helper()
	var got wire.Op
	if err := wire.JSON(r, &got); err != nil || got != want {
		t.Fatalf("apply op = %+v (%v), want %+v", got, err, want)
	}
	if contents != "" {
		data, err := wire.Read(r, wire.DataMax)
		if err != nil || string(data) != contents {
			t.Fatalf("apply data = %q (%v), want %q", data, err, contents)
		}
	}
}

func awaitApplyFetch(t *testing.T, fetched <-chan string, want string) {
	t.Helper()
	select {
	case got := <-fetched:
		if got != want {
			t.Fatalf("fetched %q, want %q", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %q", want)
	}
}

func TestApplySendsInOrderWhileFetchingAhead(t *testing.T) {
	const slowKey = "slow"
	contents := []string{slowKey, "fast", "next"}
	entries := make(map[string]objects.Entry)
	blobs := make(map[string]string)
	var ops []wire.Op
	for _, data := range contents {
		sha := store.GitHash("blob", []byte(data))
		blobs["o/"+sha] = data
		entries[data] = objects.Entry{SHA1: sha, Size: int64(len(data))}
		ops = append(ops, wire.Op{Path: data, Op: "put", Size: int64(len(data))})
	}
	ops = append(ops, wire.Op{Path: slowKey, Op: "del"})
	fetched := make(chan string, len(contents))
	unblock := make(chan struct{})
	stub := applyStoreStub{open: func(ctx context.Context, key string) (io.ReadCloser, error) {
		data := blobs[key]
		if data == slowKey {
			select {
			case <-unblock:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		fetched <- data
		return io.NopCloser(strings.NewReader(data)), nil
	}}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	server, client := net.Pipe()
	defer client.Close()
	client.SetDeadline(time.Now().Add(5 * time.Second))
	done := make(chan error, 1)
	tempDir := t.TempDir()
	go func() {
		defer server.Close()
		done <- sendApplyOps(ctx, server, store.WithDepth(stub, 2), entries, ops, tempDir, applyInflightBytes)
	}()

	// The third fetch starts before the first finishes, even with only two GET slots.
	awaitApplyFetch(t, fetched, "fast")
	awaitApplyFetch(t, fetched, "next")
	close(unblock)
	for i, data := range contents {
		readApplyOp(t, client, ops[i], data)
	}
	readApplyOp(t, client, ops[3], "")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestApplyReservesBytesUntilSent(t *testing.T) {
	// The first two fill the budget. The third needs the entire budget.
	const budget = 8
	contents := []string{"aaaa", "bbbb", "cccccccc"}
	entries := make(map[string]objects.Entry)
	blobs := make(map[string]string)
	var ops []wire.Op
	for _, data := range contents {
		sha := store.GitHash("blob", []byte(data))
		blobs["o/"+sha] = data
		entries[data] = objects.Entry{SHA1: sha, Size: int64(len(data))}
		ops = append(ops, wire.Op{Path: data, Op: "put", Size: int64(len(data))})
	}
	fetched := make(chan string, len(contents))
	stub := applyStoreStub{open: func(_ context.Context, key string) (io.ReadCloser, error) {
		data := blobs[key]
		fetched <- data
		return io.NopCloser(strings.NewReader(data)), nil
	}}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	server, client := net.Pipe()
	defer client.Close()
	client.SetDeadline(time.Now().Add(5 * time.Second))
	done := make(chan error, 1)
	tempDir := t.TempDir()
	go func() {
		defer server.Close()
		done <- sendApplyOps(ctx, server, stub, entries, ops, tempDir, budget)
	}()
	started := map[string]bool{}
	for range 2 {
		select {
		case data := <-fetched:
			started[data] = true
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if !started[contents[0]] || !started[contents[1]] {
		t.Fatalf("fetched over budget: %v", started)
	}
	assertBlocked := func() {
		t.Helper()
		select {
		case data := <-fetched:
			t.Fatalf("fetched %q before there was room in the byte budget", data)
		case <-time.After(25 * time.Millisecond):
		}
	}
	assertBlocked()
	readApplyOp(t, client, ops[0], contents[0])
	assertBlocked()
	readApplyOp(t, client, ops[1], contents[1])
	awaitApplyFetch(t, fetched, contents[2])
	readApplyOp(t, client, ops[2], contents[2])
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type zeroApplyReader struct{}

func (zeroApplyReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestApplyRestoresBlobLargerThanPrefetchBudget(t *testing.T) {
	const size = applyInflightBytes + 31
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", size)
	if _, err := io.CopyN(h, zeroApplyReader{}, size); err != nil {
		t.Fatal(err)
	}
	largeSHA := fmt.Sprintf("%x", h.Sum(nil))
	smallSHA := store.GitHash("blob", []byte("small"))
	stub := applyStoreStub{open: func(_ context.Context, key string) (io.ReadCloser, error) {
		switch key {
		case "l/o/" + largeSHA:
			return io.NopCloser(io.LimitReader(zeroApplyReader{}, size)), nil
		case "l/o/" + smallSHA:
			return io.NopCloser(strings.NewReader("small")), nil
		default:
			return nil, fmt.Errorf("unexpected open: %s", key)
		}
	}}
	entries := []objects.Entry{
		{Path: "a", SHA1: smallSHA, Mode: "100644", Size: 5},
		{Path: "b", SHA1: largeSHA, Mode: "100755", Size: size},
		{Path: "c", SHA1: smallSHA, Mode: "100644", Size: 5},
	}
	var ops []wire.Op
	for _, entry := range entries {
		ops = append(ops, wire.Op{Path: entry.Path, Op: "put", Mode: entry.Mode, Size: entry.Size})
	}
	tempDir := t.TempDir()
	m := &Manager{Config: Config{Data: tempDir, ApplyMax: 30 * time.Second}, Store: stub}
	server, client := net.Pipe()
	defer client.Close()
	client.SetDeadline(time.Now().Add(m.ApplyMax))
	done := make(chan error, 1)
	go func() {
		defer server.Close()
		done <- m.sendApply(server, "l", "large", applyTrees{Files: 3, Bytes: size + 10}, entries, ops)
	}()
	for range 3 {
		var frame any
		if err := wire.JSON(client, &frame); err != nil {
			t.Fatal(err)
		}
	}
	readApplyOp(t, client, ops[0], "small")
	readApplyOp(t, client, ops[1], "")
	h.Reset()
	fmt.Fprintf(h, "blob %d\x00", size)
	for left := size; left > 0; {
		b, err := wire.Read(client, wire.DataMax)
		if err != nil {
			t.Fatal(err)
		}
		if int64(len(b)) != min(left, int64(wire.DataMax)) {
			t.Fatalf("unexpected apply frame length: %d (%d remaining)", len(b), left)
		}
		h.Write(b)
		left -= int64(len(b))
	}
	if got := fmt.Sprintf("%x", h.Sum(nil)); got != largeSHA {
		t.Fatalf("wrong streamed blob: %s, want %s", got, largeSHA)
	}
	readApplyOp(t, client, ops[2], "small")
	readApplyOp(t, client, wire.Op{End: true, Files: 3, Bytes: size + 10}, "")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if files, err := os.ReadDir(tempDir); err != nil || len(files) != 0 {
		t.Fatalf("apply temp directory = %v (%v)", files, err)
	}
}

func TestApplyRejectsUnverifiedLargeBlob(t *testing.T) {
	const data = "payload"
	entry := objects.Entry{SHA1: store.GitHash("blob", []byte(data)), Size: int64(len(data))}
	op := wire.Op{Path: "large", Op: "put", Mode: "100644", Size: entry.Size}
	for _, tc := range []struct{ name, body string }{
		{"short", "payloa"},
		{"long", "payload!"},
		{"wrong hash", "changed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := applyStoreStub{open: func(_ context.Context, _ string) (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader(tc.body)), nil
			}}
			tempDir := t.TempDir()
			var w bytes.Buffer
			err := sendApplyOps(t.Context(), &w, stub, map[string]objects.Entry{op.Path: entry}, []wire.Op{op}, tempDir, 4)
			if err == nil || err.Error() != "corrupt blob" || w.Len() != 0 {
				t.Fatalf("apply emitted %d bytes with error %v", w.Len(), err)
			}
			if files, err := os.ReadDir(tempDir); err != nil || len(files) != 0 {
				t.Fatalf("apply temp directory = %v (%v)", files, err)
			}
		})
	}
}

func TestApplyStreamEndsWithFetchError(t *testing.T) {
	m, _ := unit3(t)
	content := []byte("blob")
	sha := root.Hash(content)
	repo := m.objects("l")
	if _, err := repo.Upload(t.Context(), "l", sha, int64(len(content)), bytes.NewReader(content)); err != nil {
		t.Fatal(err)
	}
	tree, err := repo.Import(t.Context(), objects.Request{Lineage: "l", Files: map[string]objects.File{"file": {SHA256: sha}}})
	if err != nil {
		t.Fatal(err)
	}
	v := mount3(t, m, tree.Tree, "fetch-error")
	m.Store = applyStoreStub{Store: m.Store, open: func(context.Context, string) (io.ReadCloser, error) {
		return nil, fmt.Errorf("injected apply fetch error")
	}}
	c, err := net.Dial("unix", v.streams.paths[1])
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	for range 3 {
		var frame any
		if err := wire.JSON(c, &frame); err != nil {
			t.Fatal(err)
		}
	}
	readApplyOp(t, c, wire.Op{End: true, Error: "injected apply fetch error"}, "")
	if _, err := wire.Read(c, wire.FrameMax); err != io.EOF {
		t.Fatalf("apply stream did not close after fetch error: %v", err)
	}
}

// A symlink in the apply stream is a link op with its target in JSON and no raw
// frames: jobhost's guest rejects put with mode 120000.
func TestApplySendsSymlinkAsLinkOp(t *testing.T) {
	m, _ := unit3(t)
	ctx := context.Background()
	target := []byte("../elsewhere")
	h := store.GitHash("blob", target)
	if e := m.Store.Put(ctx, "l/o/"+h, target); e != nil {
		t.Fatal(e)
	}
	server, client := net.Pipe()
	defer client.Close()
	client.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() {
		done <- m.sendApply(server, "l", "j", applyTrees{Files: 1, Bytes: int64(len(target))},
			[]objects.Entry{{Path: "link", Mode: "120000", SHA1: h, Size: int64(len(target))}},
			[]wire.Op{{Path: "link", Op: "put", Mode: "120000", Size: int64(len(target))}})
		server.Close()
	}()
	for i := 0; i < 3; i++ {
		var v any
		if e := wire.JSON(client, &v); e != nil {
			t.Fatal(e)
		}
	}
	var op wire.Op
	if e := wire.JSON(client, &op); e != nil {
		t.Fatal(e)
	}
	if op.Op != "link" || op.Path != "link" || op.Target != string(target) || op.Size != 0 || op.Mode != "" {
		t.Fatalf("symlink sent as %+v", op)
	}
	// The next frame is the trailer, not raw symlink bytes.
	var end wire.Op
	if e := wire.JSON(client, &end); e != nil || !end.End {
		t.Fatalf("expected the trailer, got %+v (%v)", end, e)
	}
}
