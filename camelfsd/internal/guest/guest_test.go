package guest

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"golang.org/x/sys/unix"
)

func fixture(t *testing.T) *guest {
	t.Helper()
	root := t.TempDir()
	g := &guest{root: root, repo: filepath.Join(root, "repo"), out: filepath.Join(root, "out"), send: func(message) error { return nil }}
	for _, p := range []string{g.repo, g.out} {
		if err := os.Mkdir(p, 0755); err != nil {
			t.Fatal(err)
		}
	}
	return g
}

func TestCommandChannel(t *testing.T) {
	g := fixture(t)
	in, send := io.Pipe()
	recv, out := io.Pipe()
	defer send.Close()
	defer recv.Close()
	done := make(chan error, 1)
	go func() { defer out.Close(); done <- serve(context.Background(), in, out, g) }()
	dec := json.NewDecoder(recv)
	for _, tc := range []struct {
		request string
		check   func(message) bool
	}{
		{"{", func(m message) bool { return m["error"] == "Invalid request" }},
		{`{"op":"bogus"}`, func(m message) bool { return m["error"] == "Unknown op bogus" }},
		{`{"op":"files","files":[{"path":"a","data":"YQ"},{"path":"a","data":"Yg","append":true}]}`, func(m message) bool { return m["ok"] == true }},
		{`{"op":"files","files":[{"path":"../a","data":""}]}`, func(m message) bool { return m["error"] == `Invalid path: "../a"` }},
		{`{"op":"free"}`, func(m message) bool { return m["freeBytes"].(float64) > 0 }},
		{`{"op":"run","command":"cat a; printf x > \"$JOB_OUT/result\"; exit 3","timeoutSeconds":5}`, func(m message) bool {
			return m["exitCode"] == float64(3) && m["stdout"].(map[string]any)["data"] == "YWI="
		}},
		{`{"op":"collect","outputs":["result","missing"]}`, func(m message) bool {
			return len(m["outputs"].(map[string]any)) == 1 && reflect.DeepEqual(m["missing"], []any{"missing"})
		}},
		{`{"op":"exit"}`, func(m message) bool { return reflect.DeepEqual(m, message{"ok": true}) }},
	} {
		fmt.Fprintln(send, tc.request)
		var logs []message
		for {
			var m message
			if err := dec.Decode(&m); err != nil {
				t.Fatal(err)
			}
			if m["event"] == "log" {
				logs = append(logs, m)
				continue
			}
			if !tc.check(m) {
				t.Fatalf("%s: %v", tc.request, m)
			}
			if strings.Contains(tc.request, `"run"`) && len(logs) == 0 {
				t.Fatal("no logs before run reply")
			}
			break
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRunCapsAndPIDLimit(t *testing.T) {
	g := fixture(t)
	g.send = func(m message) error {
		if len(m["data"].(string)) > (logChunkBytes+2)/3*4 {
			t.Error("log exceeds chunk cap")
		}
		return nil
	}
	r, err := g.run(context.Background(), request{Command: "head -c 8388609 /dev/zero", TimeoutSeconds: 5})
	if err != nil || r["exitCode"] != 0 {
		t.Fatal(r, err)
	}
	out := r["stdout"].(stream)
	if out.Size != streamBytes+1 || !out.Truncated || len(out.Data) != (streamBytes+2)/3*4 {
		t.Fatal("bad stdout cap")
	}
	// A number wider than an unsigned rlimit is rejected by both cgroup and bash.
	r, err = g.run(context.Background(), request{Command: "exit 42", Pids: 1e25, TimeoutSeconds: 5})
	if err != nil || r["exitCode"] != 125 {
		t.Fatal(r, err)
	}
	for _, name := range []string{"a", "b"} {
		if err := os.WriteFile(filepath.Join(g.out, name), make([]byte, outputBytes/2+1), 0600); err != nil {
			t.Fatal(err)
		}
	}
	r, err = g.collect([]string{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	outputs := r["outputs"].(map[string]stream)
	if outputs["a"].Truncated || !outputs["b"].Truncated || !reflect.DeepEqual(r["missing"], []string{"c"}) {
		t.Fatal("bad collect cap")
	}
}

func TestRunKillsGroup(t *testing.T) {
	for _, closed := range []bool{false, true} {
		t.Run(fmt.Sprintf("channelClosed=%v", closed), func(t *testing.T) {
			g := fixture(t)
			in, w := io.Pipe()
			defer w.Close()
			out, r := io.Pipe()
			defer out.Close()
			dec := json.NewDecoder(out)
			done := make(chan error, 1)
			go func() { defer r.Close(); done <- serve(context.Background(), in, r, g) }()
			fmt.Fprintln(w, `{"op":"run","command":"sleep 30 & echo $!; wait","timeoutSeconds":1}`)
			var log struct {
				Event string
				Data  []byte
			}
			if err := dec.Decode(&log); err != nil || log.Event != "log" {
				t.Fatal(log, err)
			}
			var pid int
			if _, err := fmt.Sscan(string(log.Data), &pid); err != nil {
				t.Fatal(err)
			}
			if closed {
				w.Close()
			} else {
				var result message
				if err := dec.Decode(&result); err != nil || result["timedOut"] != true || result["exitCode"] != nil {
					t.Fatal(result, err)
				}
				w.Close()
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("guest did not end")
			}
			// An adopted descendant may briefly be a zombie until the enclosing PID 1 reaps it.
			for i := 0; i < 100; i++ {
				stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
				if os.IsNotExist(err) || strings.Contains(string(stat), ") Z ") {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
			t.Fatal("descendant survived")
		})
	}
}

func streamListener(t *testing.T, g *guest, port int, handler func(net.Conn) error) <-chan error {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "k1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	g.uds = filepath.Join(dir, "v")
	l, err := net.Listen("unix", fmt.Sprintf("%s_%d", g.uds, port))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	done := make(chan error, 1)
	go func() {
		c, err := l.Accept()
		if err == nil {
			defer c.Close()
			c.SetDeadline(time.Now().Add(5 * time.Second))
			err = handler(c)
		}
		done <- err
	}()
	return done
}

func TestApplyRejectsBadFramesAndPaths(t *testing.T) {
	tree := strings.Repeat("a", 40)
	for _, tc := range []struct{ name, path, want string }{
		{"git", ".git/config", "path is under .git"},
		{"dotdot", "../x", "invalid path component"},
		{"component", strings.Repeat("x", 256), "path component exceeds 255 bytes"},
		{"oversized", "", "frame exceeds frameMax"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := fixture(t)
			peer := streamListener(t, g, 5201, func(c net.Conn) error {
				if err := wire.Send(c, wire.Header{V: 1, Kind: "apply", JobID: "j", ToTree: tree}); err != nil {
					return err
				}
				if err := wire.Send(c, message{"indexEnd": true, "count": 0}); err != nil {
					return err
				}
				if tc.path != "" {
					if err := wire.Send(c, operation{Path: tc.path, Op: "del"}); err != nil {
						return err
					}
				} else {
					if _, err := c.Write(binary.BigEndian.AppendUint32(nil, wire.DataMax+wire.JSONMax+1)); err != nil {
						return err
					}
				}
				var reply struct {
					Applied bool
					Error   string
				}
				if err := wire.JSON(c, &reply); err != nil {
					return err
				}
				if reply.Applied || !strings.Contains(reply.Error, tc.want) {
					return fmt.Errorf("bad nack: %+v", reply)
				}
				return nil
			})
			_, err := g.apply(context.Background(), request{JobID: "j", TimeoutMs: 1000})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatal(err)
			}
			if err := <-peer; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestApplyTimeoutRepliesToDaemon(t *testing.T) {
	g := fixture(t)
	peer := streamListener(t, g, 5201, func(c net.Conn) error {
		var reply struct {
			Applied bool
			Error   string
		}
		if err := wire.JSON(c, &reply); err != nil {
			return err
		}
		if reply.Applied || reply.Error != "camelFS apply timed out" {
			return fmt.Errorf("bad apply reply: %+v", reply)
		}
		return nil
	})
	_, err := g.apply(context.Background(), request{JobID: "j", TimeoutMs: 150})
	if err == nil || err.Error() != "camelFS apply timed out" {
		t.Fatal(err)
	}
	if err := <-peer; err != nil {
		t.Fatal(err)
	}
}

func TestCheckpointThawsOnTimeout(t *testing.T) {
	g := fixture(t)
	g.index = &index{Tree: strings.Repeat("a", 40)}
	if err := os.WriteFile(filepath.Join(g.repo, "changed"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	frozen, thawed := false, false
	g.freeze = func() (func() error, error) {
		frozen = true
		return func() error { thawed = true; return nil }, nil
	}
	peer := streamListener(t, g, 5200, func(c net.Conn) error {
		if err := wire.Send(c, message{"ready": true}); err != nil {
			return err
		}
		r := bufio.NewReader(c)
		for range 2 {
			var frame message
			if err := wire.JSON(r, &frame); err != nil {
				return err
			}
		}
		if _, err := wire.Read(r, wire.DataMax); err != nil {
			return err
		}
		var end message
		if err := wire.JSON(r, &end); err != nil {
			return err
		}
		_, err := r.ReadByte()
		if err == io.EOF {
			return nil
		}
		return fmt.Errorf("expected EOF, got %v", err)
	})
	_, err := g.checkpoint(context.Background(), request{JobID: "j", TimeoutMs: 150})
	if err == nil || err.Error() != "camelFS checkpoint timed out" || !frozen || !thawed {
		t.Fatal(err, frozen, thawed)
	}
	if _, err := g.checkpointed(request{}); err == nil || err.Error() != "no pending checkpoint" {
		t.Fatal(err)
	}
	if err := <-peer; err != nil {
		t.Fatal(err)
	}
}

func TestInitOrdering(t *testing.T) {
	var steps []string
	cfg := setupBoot(bootSystem{
		mount: func(m mount) error {
			steps = append(steps, m.target)
			if m.target == "/repo" && (m.source != "/dev/vdb" || m.kind != "ext4" || m.flags != unix.MS_NOATIME) {
				t.Fatal(m)
			}
			return nil
		},
		prepare: func() { steps = append(steps, "prepare") },
		readCmdline: func() ([]byte, error) {
			steps = append(steps, "cmdline")
			return []byte("camel.repo=/dev/vdx quiet camel.repo=/dev/vdb camel.ip=10.0.0.2/30 camel.gw=10.0.0.1 camel.proxy=http://10.0.0.1:3128"), nil
		},
		network: func(c bootConfig) { steps = append(steps, "network") },
		writeFile: func(p string, b []byte, _ os.FileMode) error {
			steps = append(steps, p)
			if p == "/etc/resolv.conf" && len(b) != 0 {
				t.Fatal(string(b))
			}
			if p == "/etc/profile.d/camel-proxy.sh" && (!bytes.Contains(b, []byte("HTTPS_PROXY=http://10.0.0.1:3128")) || !bytes.HasSuffix(b, []byte("no_proxy=localhost,127.0.0.1\n"))) {
				t.Fatal(string(b))
			}
			return nil
		},
		report: func(err error) { t.Fatal(err) },
	})
	if cfg != (bootConfig{ip: "10.0.0.2/30", gw: "10.0.0.1", proxy: "http://10.0.0.1:3128", repo: "/dev/vdb"}) {
		t.Fatal(cfg)
	}
	want := []string{"/proc", "/sys", "/dev", "/dev/pts", "/dev/shm", "/run", "/sys/fs/cgroup", "prepare", "cmdline", "network", "/etc/resolv.conf", "/etc/profile.d/camel-proxy.sh", "/repo"}
	if !reflect.DeepEqual(steps, want) {
		t.Fatal(steps)
	}
}

func TestSessionWorkspace(t *testing.T) {
	var targets []mount
	cfg := setupBoot(bootSystem{
		mount:       func(m mount) error { targets = append(targets, m); return nil },
		prepare:     func() {},
		readCmdline: func() ([]byte, error) { return []byte("camel.workspace=/dev/vdb"), nil },
		network:     func(bootConfig) {},
		writeFile:   func(string, []byte, os.FileMode) error { return nil },
		report:      func(e error) { t.Fatal(e) },
	})
	want := mount{"/dev/vdb", "/workspace", "ext4", unix.MS_NOATIME}
	if cfg.workspaceFailed || len(targets) != len(earlyMounts)+1 || targets[len(targets)-1] != want {
		t.Fatalf("session mounts: %v", targets)
	}
	g := &guest{session: true, root: "/"}
	if cwd := g.workdir(); cwd != "/workspace" {
		t.Fatalf("new shell cwd = %q", cwd)
	}
}
