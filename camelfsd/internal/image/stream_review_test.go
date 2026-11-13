package image

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net"
	"os"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

func TestPreparedReceiveNeedsNoDatabaseOrStore(t *testing.T) {
	m, tree := unit3(t)
	b := []byte("base")
	sha := fmtHash(b)
	if _, e := m.objects("l").Upload(context.Background(), "l", sha, int64(len(b)), bytes.NewReader(b)); e != nil {
		t.Fatal(e)
	}
	tr, e := m.objects("l").Import(context.Background(), objects.Request{Lineage: "l", ParentTree: tree, Files: map[string]objects.File{"base": {SHA256: sha}}})
	if e != nil {
		t.Fatal(e)
	}
	v := mount3(t, m, tr.Tree, "prepared")
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
func TestApplyBatchByteBound(t *testing.T) {
	ops := []wire.Op{{Size: 128 << 20}, {Size: 128 << 20}, {Size: 1}, {Size: 256 << 20}}
	if n := applyBatchEnd(ops, 0, 64); n != 2 {
		t.Fatal(n)
	}
	if n := applyBatchEnd(ops, 0, 1); n != 1 {
		t.Fatal(n)
	}
	if n := applyBatchEnd(ops, 2, 64); n != 3 {
		t.Fatal(n)
	}
}

type slowApplyStore struct {
	store.Store
	slow    string
	unblock <-chan struct{}
}

func (s slowApplyStore) Get(ctx context.Context, k string) ([]byte, error) {
	if k == s.slow {
		select {
		case <-s.unblock:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.Store.Get(ctx, k)
}
func TestApplyStreamsBeforeBatchCompletes(t *testing.T) {
	m, _ := unit3(t)
	ctx := context.Background()
	a, b := []byte("fast"), []byte("slow")
	ha, hb := store.GitHash("blob", a), store.GitHash("blob", b)
	m.Store.Put(ctx, "l/o/"+ha, a)
	m.Store.Put(ctx, "l/o/"+hb, b)
	unblock := make(chan struct{})
	defer close(unblock)
	m.Store = slowApplyStore{m.Store, "l/o/" + hb, unblock}
	server, client := net.Pipe()
	defer client.Close()
	client.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() {
		done <- m.sendApply(server, "l", "j", Apply{Files: 2, Bytes: 8}, []objects.Entry{{Path: "a", SHA1: ha, Size: 4}, {Path: "b", SHA1: hb, Size: 4}}, []wire.Op{{Path: "a", Op: "put", Size: 4}, {Path: "b", Op: "put", Size: 4}})
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
	if op.Path != "a" {
		t.Fatal(op)
	}
	data, e := wire.Read(client, wire.DataMax)
	if e != nil || !bytes.Equal(data, a) {
		t.Fatal(e, string(data))
	}
	client.Close()
}
