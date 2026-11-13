package image

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/testguest"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func unit3(t *testing.T) (*Manager, string) {
	t.Helper()
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	data := t.TempDir()
	s := store.Local{Dir: t.TempDir()}
	db, e := refs.Open(filepath.Join(data, "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	m, e := New(Config{Data: data, Cold: "prehydrate", HostID: "test", VirtualSize: 16 << 20}, s, cache.New(filepath.Join(data, "cache"), s, 64), db)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { m.Close(); db.Close() })
	r, e := m.objects().Import(context.Background(), objects.Request{Lineage: "l", Files: map[string]objects.File{}})
	if e != nil {
		t.Fatal(e)
	}
	return m, r.Tree
}
func mount3(t *testing.T, m *Manager, tree, job string) *Mount {
	t.Helper()
	v, e := m.Mount(context.Background(), Request{Lineage: "l", Tree: tree, JobID: job, Vsock: filepath.Join(testutil.SocketDir(t), "v")})
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func armed3(t *testing.T, v *Mount) net.Conn {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		c, e := net.Dial("unix", v.Vsock+"_5200")
		if e != nil {
			t.Fatal(e)
		}
		c.SetDeadline(time.Now().Add(time.Second))
		var r struct {
			Ready bool `json:"ready"`
		}
		if wire.JSON(c, &r) == nil && r.Ready {
			return c
		}
		c.Close()
		time.Sleep(time.Millisecond)
	}
	t.Fatal("not armed")
	return nil
}
func TestHostileStreams(t *testing.T) {
	for _, name := range []string{"oversized-frame", "oversized-json", "size-more", "size-less", "dotdot", "git", "absolute", "nul", "component", "duplicate", "file-dir", "bad-mode", "long-link", "wrong-job", "wrong-base", "max-bytes", "max-files", "max-paths", "stall"} {
		t.Run(name, func(t *testing.T) {
			m, tree := unit3(t)
			if name == "max-files" {
				m.MaxFiles = 1
			}
			if name == "max-paths" {
				m.MaxPathsBytes = 1
			}
			v := mount3(t, m, tree, "evil")
			before, _ := m.Refs.Get("l", v.Ref)
			done := make(chan error, 1)
			go func() { _, e := m.StreamCheckpoint(context.Background(), "evil", 250, CheckpointRequest{}); done <- e }()
			for {
				v.streams.mu.Lock()
				armed := v.streams.armed != nil
				v.streams.mu.Unlock()
				if armed {
					break
				}
				time.Sleep(time.Millisecond)
			}
			c, e := net.Dial("unix", v.Vsock+"_5200")
			if e != nil {
				t.Fatal(e)
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(time.Second))
			go testguest.Evil(c, name, "evil", tree)
			e = <-done
			if name == "stall" {
				if !errors.Is(e, ErrStreamTimeout) {
					t.Fatal(e)
				}
			} else if !errors.Is(e, ErrBadStream) {
				t.Fatal(e)
			}
			after, _ := m.Refs.Get("l", v.Ref)
			if before.Value != after.Value {
				t.Fatal("partial ref publish")
			}
			db := m.Refs.(*refs.DB)
			var n int
			db.DB.QueryRow("SELECT count(*) FROM tree_roots").Scan(&n)
			if n != 0 {
				t.Fatal("partial tree root")
			}
			tmp, _ := filepath.Glob(filepath.Join(m.Data, "checkpoint-*"))
			if len(tmp) != 0 {
				t.Fatal(tmp)
			}
		})
	}
}
func TestArmingAndMountIsolation(t *testing.T) {
	m, tree := unit3(t)
	v := mount3(t, m, tree, "a")
	other := mount3(t, m, tree, "b")
	c, e := net.Dial("unix", v.Vsock+"_5200")
	if e != nil {
		t.Fatal(e)
	}
	c.SetDeadline(time.Now().Add(time.Second))
	var one [1]byte
	if n, e := c.Read(one[:]); n != 0 || e == nil {
		t.Fatal("unarmed received bytes")
	}
	c.Close()
	done := make(chan error, 1)
	go func() { _, e := m.StreamCheckpoint(context.Background(), "a", 500); done <- e }()
	active := armed3(t, v)
	defer active.Close()
	second, e := net.Dial("unix", v.Vsock+"_5200")
	if e != nil {
		t.Fatal(e)
	}
	second.SetDeadline(time.Now().Add(time.Second))
	if n, e := second.Read(one[:]); n != 0 || e == nil {
		t.Fatal("second accepted")
	}
	second.Close()
	if _, e = m.Status(context.Background(), "b"); e != nil {
		t.Fatal(e)
	}
	go func() {
		c := armed3(t, other)
		defer c.Close()
		wire.Send(c, wire.Header{V: 1, Kind: "checkpoint", JobID: "b", BaseTree: tree})
		wire.Send(c, wire.Op{End: true})
		var ack any
		wire.JSON(c, &ack)
	}()
	if _, e = m.StreamCheckpoint(context.Background(), "b", 1000, CheckpointRequest{}); e != nil {
		t.Fatal(e)
	}
	if _, e = m.Release(context.Background(), "b"); e != nil {
		t.Fatal(e)
	}
	if e = <-done; !errors.Is(e, ErrStreamTimeout) {
		t.Fatal(e)
	}
	if _, e = m.Fork(context.Background(), ForkRequest{Lineage: "l", FromRef: v.Ref, Name: "held"}); !errors.Is(e, ErrHeld) {
		t.Fatal(e)
	}
}
func TestApplyCheckpointForkCommit(t *testing.T) {
	m, tree := unit3(t)
	v := mount3(t, m, tree, "j")
	dir := t.TempDir()
	index := filepath.Join(t.TempDir(), "idx.json")
	if e := testguest.Apply(v.Vsock, "j", dir, index); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 100; i++ {
		s, _ := m.Status(context.Background(), "j")
		if s.Applied {
			break
		}
		time.Sleep(time.Millisecond)
	}
	c, e := net.Dial("unix", v.Vsock+"_5201")
	if e != nil {
		t.Fatal(e)
	}
	c.SetDeadline(time.Now().Add(time.Second))
	var b [1]byte
	if n, e := c.Read(b[:]); n != 0 || e == nil {
		t.Fatal("second apply accepted")
	}
	c.Close()
	done := make(chan error, 1)
	go func() {
		c := armed3(t, v)
		defer c.Close()
		wire.Send(c, wire.Header{V: 1, Kind: "checkpoint", JobID: "j", BaseTree: tree, WalkMs: 1})
		wire.Send(c, wire.Op{Path: "hello", Op: "put", Mode: "100644", Size: 5})
		wire.Write(c, []byte("world"))
		wire.Send(c, wire.Op{End: true, Files: 1, Bytes: 5})
		var ack struct {
			Ack bool `json:"ack"`
		}
		e := wire.JSON(c, &ack)
		if !ack.Ack && e == nil {
			e = errors.New("no ack")
		}
		done <- e
	}()
	msg := "save"
	out, e := m.StreamCheckpoint(context.Background(), "j", 2000, CheckpointRequest{Message: &msg, Trailers: &Trailers{Agent: "bot", Kind: "manual"}})
	if e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	if out.Tree == tree || out.Commit == "" || out.FilesChanged != 1 || out.BytesReceived != 5 {
		t.Fatal(out)
	}
	commit, e := m.Commit(context.Background(), out.Commit)
	if e != nil || commit["tree"] != out.Tree {
		t.Fatal(commit, e)
	}
	var raw []byte
	m.objects().DB.DB.QueryRow("SELECT bytes FROM objects WHERE id=?", out.Commit).Scan(&raw)
	git := t.TempDir()
	if b, e := exec.Command("git", "init", "--bare", git).CombinedOutput(); e != nil {
		t.Fatalf("%s %v", b, e)
	}
	cmd := exec.Command("git", "--git-dir", git, "hash-object", "-t", "commit", "--stdin", "-w")
	cmd.Stdin = bytes.NewReader(raw)
	id, e := cmd.Output()
	if e != nil || string(bytes.TrimSpace(id)) != out.Commit {
		t.Fatal(string(id), e)
	}
	printed, e := exec.Command("git", "--git-dir", git, "cat-file", "-p", out.Commit).Output()
	if e != nil || !bytes.Equal(raw, printed) {
		t.Fatal(e)
	}
	m.Release(context.Background(), "j")
	fork, e := m.Fork(context.Background(), ForkRequest{Lineage: "l", FromTree: out.Tree, Name: "exp/1", Owner: "test"})
	if e != nil || fork["root"] != out.Root {
		t.Fatal(fork, e)
	}
	warm := mount3(t, m, out.Tree, "warm")
	if warm.Apply != nil || !warm.Warm {
		t.Fatal(warm)
	}
}
func TestNearestAncestor(t *testing.T) {
	m, tree := unit3(t)
	v := mount3(t, m, tree, "base")
	cp, e := m.Checkpoint(context.Background(), v.JobID)
	if e != nil {
		t.Fatal(e)
	}
	repo := m.objects()
	b := []byte("x")
	sha := fmtHash(b)
	if _, e = repo.Upload(context.Background(), "l", sha, 1, bytes.NewReader(b)); e != nil {
		t.Fatal(e)
	}
	child, e := repo.Import(context.Background(), objects.Request{Lineage: "l", ParentTree: tree, Files: map[string]objects.File{"x": {SHA256: sha}}})
	if e != nil {
		t.Fatal(e)
	}
	v2 := mount3(t, m, child.Tree, "child")
	if v2.Root != cp.Root || v2.Apply == nil || v2.Apply.FromTree != tree || v2.Apply.Files != 1 {
		t.Fatal(v2)
	}
	if _, e = os.Stat(filepath.Join(m.Data, "images", "blank-16777216.img")); e != nil {
		t.Fatal(e)
	}
}
func fmtHash(b []byte) string { return root.Hash(b) }

type brokenStore struct{ store.Store }

func (s brokenStore) Put(context.Context, string, []byte) error {
	return errors.New("injected upload failure")
}
func TestAckThenPublishFailure(t *testing.T) {
	m, tree := unit3(t)
	v := mount3(t, m, tree, "failure")
	before, _ := m.Refs.Get("l", v.Ref)
	m.Store = brokenStore{m.Store}
	acked := make(chan bool, 1)
	go func() {
		c := armed3(t, v)
		defer c.Close()
		wire.Send(c, wire.Header{V: 1, Kind: "checkpoint", JobID: v.JobID, BaseTree: tree})
		wire.Send(c, wire.Op{Path: "x", Op: "put", Mode: "100644", Size: 1})
		wire.Write(c, []byte("x"))
		wire.Send(c, wire.Op{End: true, Files: 1, Bytes: 1})
		var ack struct {
			Ack bool `json:"ack"`
		}
		wire.JSON(c, &ack)
		acked <- ack.Ack
	}()
	if _, e := m.StreamCheckpoint(context.Background(), v.JobID, 2000); e == nil {
		t.Fatal("publish succeeded")
	}
	if !<-acked {
		t.Fatal("missing pre-upload ack")
	}
	after, _ := m.Refs.Get("l", v.Ref)
	if before.Value != after.Value {
		t.Fatal("partial ref publish")
	}
	var n int
	m.objects().DB.DB.QueryRow("SELECT count(*) FROM tree_roots").Scan(&n)
	if n != 0 {
		t.Fatal("partial mapping")
	}
}

func TestConcurrentPromotion(t *testing.T) {
	m, _ := unit3(t)
	src := filepath.Join(m.Data, "source.img")
	b := []byte("identical immutable image")
	if e := os.WriteFile(src, b, 0600); e != nil {
		t.Fatal(e)
	}
	id := root.Hash(b)
	done := make(chan error, 16)
	for i := 0; i < 16; i++ {
		go func() { done <- m.promote(src, id) }()
	}
	for i := 0; i < 16; i++ {
		if e := <-done; e != nil {
			t.Fatal(e)
		}
	}
	got, e := os.ReadFile(m.image(id))
	if e != nil || !bytes.Equal(b, got) {
		t.Fatal(e)
	}
}

func TestCheckpointIdleTimeoutNack(t *testing.T) {
	m, tr := unit3(t)
	m.StreamIdle = 25 * time.Millisecond
	v := mount3(t, m, tr, "idle")
	done := make(chan error, 1)
	go func() { _, e := m.StreamCheckpoint(context.Background(), v.JobID, 1000); done <- e }()
	c := armed3(t, v)
	defer c.Close()
	var nack struct {
		Ack   bool
		Error string
	}
	if e := wire.JSON(c, &nack); e != nil || nack.Ack || nack.Error != "stream-timeout" {
		t.Fatalf("nack=%+v error=%v", nack, e)
	}
	select {
	case e := <-done:
		if !errors.Is(e, ErrStreamTimeout) {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("POST did not return")
	}
}
func TestApplyProgressOutlivesIdleBudget(t *testing.T) {
	m, _ := unit3(t)
	m.StreamIdle = 50 * time.Millisecond
	m.ApplyMax = time.Second
	a, c := net.Pipe()
	defer a.Close()
	defer c.Close()
	done := make(chan error, 1)
	go func() {
		stream := &wire.DeadlineConn{Conn: a, Idle: m.StreamIdle, Overall: time.Now().Add(m.ApplyMax)}
		if e := m.sendApply(stream, "slow", Apply{}, nil, nil); e != nil {
			done <- e
			return
		}
		var reply map[string]bool
		done <- wire.JSON(stream, &reply)
	}()
	start := time.Now()
	for {
		frame, e := wire.Read(c, wire.JSONMax)
		if e != nil {
			t.Fatal(e)
		}
		var end struct{ End bool }
		if e = json.Unmarshal(frame, &end); e != nil {
			t.Fatal(e)
		}
		time.Sleep(30 * time.Millisecond)
		if end.End {
			break
		}
	}
	if time.Since(start) <= m.StreamIdle {
		t.Fatal("did not exceed fixed idle interval")
	}
	if e := wire.Send(c, map[string]bool{"applied": true}); e != nil {
		t.Fatal(e)
	}
	if e := <-done; e != nil {
		t.Fatal(e)
	}
}
