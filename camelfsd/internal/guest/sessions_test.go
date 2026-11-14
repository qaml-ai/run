package guest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

type sessionPeer struct {
	t    *testing.T
	conn net.Conn
	dec  *json.Decoder
	done chan error
}

func sessionPeerFor(t *testing.T, g *guest) *sessionPeer {
	t.Helper()
	host, guest := net.Pipe()
	p := &sessionPeer{t, host, json.NewDecoder(host), make(chan error, 1)}
	go func() {
		defer guest.Close()
		p.done <- serve(context.Background(), guest, guest, g)
	}()
	t.Cleanup(func() { host.Close() })
	return p
}

// peerStepTimeout bounds one exchange, not the whole test: a test may make dozens of exec round trips
// (TestExecRetention runs execExits+1 bash processes), which can exceed any fixed total on a loaded runner.
const peerStepTimeout = 15 * time.Second

func (p *sessionPeer) send(m message) {
	p.t.Helper()
	p.conn.SetWriteDeadline(time.Now().Add(peerStepTimeout))
	if err := json.NewEncoder(p.conn).Encode(m); err != nil {
		p.t.Fatal(err)
	}
}

func (p *sessionPeer) read() message {
	p.t.Helper()
	var m message
	p.conn.SetReadDeadline(time.Now().Add(peerStepTimeout))
	if err := p.dec.Decode(&m); err != nil {
		p.t.Fatal(err)
	}
	return m
}

func (p *sessionPeer) req(m message) message {
	p.t.Helper()
	p.send(m)
	return p.read()
}

func (p *sessionPeer) end(id string, offset int) (string, message) {
	p.t.Helper()
	var output strings.Builder
	for {
		m := p.read()
		if m["execId"] != id {
			p.t.Fatal(m)
		}
		switch m["event"] {
		case "tail_truncated":
			offset = int(m["firstOffset"].(float64))
		case "exec_output":
			b, err := base64.StdEncoding.DecodeString(m["data"].(string))
			if err != nil || m["offset"] != float64(offset) {
				p.t.Fatal(m, err, offset)
			}
			offset += len(b)
			output.Write(b)
		case "exec_exit":
			return output.String(), m
		default:
			p.t.Fatal(m)
		}
	}
}

func accepted(t *testing.T, m message) {
	t.Helper()
	if m["ok"] != true || m["accepted"] != true {
		t.Fatal(m)
	}
}

func TestSessionReconnectAndReplay(t *testing.T) {
	g := fixture(t)
	t.Cleanup(g.sessions.close)
	p := sessionPeerFor(t, g)
	sh := p.req(message{"op": "shell_open"})["shellId"]
	exec := message{"op": "exec", "execId": "original", "shell": sh, "command": "echo x >> count; printf before; until [[ -e release ]]; do sleep .02; done; printf after", "timeoutS": 10}
	accepted(t, p.req(exec))
	output := p.read()
	if output["event"] != "exec_output" || output["data"] != "YmVmb3Jl" {
		t.Fatal(output)
	}
	p.conn.Close()
	if err := <-p.done; err != nil {
		t.Fatal(err)
	}
	p = sessionPeerFor(t, g)
	sessions := p.req(message{"op": "sessions"})
	active := sessions["execs"].([]any)[0].(map[string]any)
	if active["execId"] != "original" || active["running"] != true || active["nextOffset"] != float64(6) || sessions["shells"].([]any)[0] != sh {
		t.Fatal(sessions)
	}
	if r := p.req(message{"op": "exec", "execId": "other", "shell": sh, "command": "true"}); r["code"] != "shell_busy" {
		t.Fatal(r)
	}
	if r := p.req(message{"op": "exec_tail", "execId": "original", "offset": 6}); r["ok"] != true {
		t.Fatal(r)
	}
	if err := os.WriteFile(filepath.Join(g.repo, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if data, end := p.end("original", 6); data != "after" || end["code"] != float64(0) {
		t.Fatal(data, end)
	}
	exec["timeoutS"] = 1 // Timeout is excluded from the execution identity.
	accepted(t, p.req(exec))
	if data, end := p.end("original", 0); data != "beforeafter" || end["code"] != float64(0) {
		t.Fatal(data, end)
	}
	if r := p.req(message{"op": "exec_tail", "execId": "original", "offset": 3}); r["ok"] != true {
		t.Fatal(r)
	}
	if data, _ := p.end("original", 3); data != "oreafter" {
		t.Fatal(data)
	}
	exec["stdin"] = "different"
	if r := p.req(exec); r["code"] != "exec_conflict" {
		t.Fatal(r)
	}
	if data, err := os.ReadFile(filepath.Join(g.repo, "count")); err != nil || string(data) != "x\n" {
		t.Fatal(string(data), err)
	}
}

func TestShellKeyReplaysAcrossReconnectAndExit(t *testing.T) {
	g := fixture(t)
	t.Cleanup(g.sessions.close)
	p := sessionPeerFor(t, g)
	open := func(key string) string {
		t.Helper()
		reply := p.req(message{"op": "shell_open", "shellKey": key})
		id, _ := reply["shellId"].(string)
		if id == "" || reply["ok"] != true {
			t.Fatal(reply)
		}
		return id
	}
	id := open("key-1")
	p.conn.Close()
	if err := <-p.done; err != nil {
		t.Fatal(err)
	}
	p = sessionPeerFor(t, g)
	if replay := open("key-1"); replay != id {
		t.Fatalf("replay opened %s, want %s", replay, id)
	}
	if r := p.req(message{"op": "sessions"}); len(r["shells"].([]any)) != 1 {
		t.Fatal(r)
	}
	if other := open("key-2"); other == id {
		t.Fatalf("different keys share shell %s", id)
	}
	accepted(t, p.req(message{"op": "exec", "execId": "exit", "shell": id, "command": "exit"}))
	p.end("exit", 0)
	if replay := open("key-1"); replay != id {
		t.Fatalf("exited shell replay opened %s, want %s", replay, id)
	}
	if r := p.req(message{"op": "exec", "execId": "after-exit", "shell": id, "command": "true"}); r["code"] != "shell_unknown" {
		t.Fatal(r)
	}
	if r := p.req(message{"op": "sessions"}); len(r["shells"].([]any)) != 1 {
		t.Fatal(r)
	}
}

func TestShellPersistenceAndSentinel(t *testing.T) {
	g := fixture(t)
	t.Cleanup(g.sessions.close)
	p := sessionPeerFor(t, g)
	sh := p.req(message{"op": "shell_open"})["shellId"]
	accepted(t, p.req(message{"op": "exec", "execId": "setup", "shell": sh, "command": "mkdir nested; cd nested; export WORD=kept; say() { printf '%s' \"$WORD\"; }"}))
	if _, end := p.end("setup", 0); end["code"] != float64(0) {
		t.Fatal(end)
	}
	// Status-looking output on either stream is ordinary data.
	const fake = "0123456789abcdef0123456789abcdef:0\n"
	accepted(t, p.req(message{
		"op": "exec", "execId": "check", "shell": sh, "stdin": " in\n", "env": map[string]string{"ARG": " quote'd"},
		"command": "printf '%s' " + quote(fake) + "; printf '%s' " + quote(fake) + " >&2; printf '%s' \"${PWD##*/} \"; say; printf '%s' \"$ARG\"; cat; (exit 7)",
	}))
	var streams = map[string]string{}
	for {
		m := p.read()
		if m["event"] == "exec_exit" {
			if m["code"] != float64(7) || streams["stdout"] != fake+"nested kept quote'd in\n" || streams["stderr"] != fake {
				t.Fatal(m, streams)
			}
			break
		}
		if m["event"] != "exec_output" {
			t.Fatal(m)
		}
		b, err := base64.StdEncoding.DecodeString(m["data"].(string))
		if err != nil {
			t.Fatal(err)
		}
		streams[m["stream"].(string)] += string(b)
	}
	accepted(t, p.req(message{"op": "exec", "execId": "timeout", "shell": sh, "command": "sleep 30", "timeoutS": 1}))
	if _, end := p.end("timeout", 0); end["timedOut"] != true || end["code"] != nil {
		t.Fatal(end)
	}
	if r := p.req(message{"op": "exec", "execId": "after-timeout", "shell": sh, "command": "true"}); r["code"] != "shell_unknown" {
		t.Fatal(r)
	}
}

func TestExecRetention(t *testing.T) {
	g := fixture(t)
	p := sessionPeerFor(t, g)
	execute := func(id, command string) {
		t.Helper()
		accepted(t, p.req(message{"op": "exec", "execId": id, "command": command, "timeoutS": 5}))
		body, end := p.end(id, 0)
		if end["code"] != float64(0) || (id == "large" && len(body) != tailBytes+123) {
			t.Fatal(len(body), end)
		}
	}
	tail := func(id string) message {
		return p.req(message{"op": "exec_tail", "execId": id, "offset": 0})
	}
	execute("large", fmt.Sprintf("head -c %d /dev/zero", tailBytes+123))
	if r := tail("large"); r["ok"] != true {
		t.Fatal(r)
	}
	m := p.read()
	first, _ := m["firstOffset"].(float64)
	if m["event"] != "tail_truncated" || first < 123 {
		t.Fatal(m)
	}
	if data, _ := p.end("large", int(first)); len(data) > tailBytes || len(data)+int(first) != tailBytes+123 {
		t.Fatal(len(data), first)
	}
	for i := range execExits {
		execute(fmt.Sprint(i), "printf data")
		if i == execTails-1 {
			if r := tail("large"); r["ok"] != true {
				t.Fatal(r)
			}
			if r := p.read(); r["event"] != "tail_truncated" || r["firstOffset"] != float64(tailBytes+123) {
				t.Fatal(r)
			}
			if data, _ := p.end("large", tailBytes+123); data != "" {
				t.Fatal(data)
			}
		}
	}
	if r := tail("large"); r["code"] != "exec_unknown" {
		t.Fatal(r)
	}
	if r := tail("0"); r["ok"] != true {
		t.Fatal(r)
	}
	if data, _ := p.end("0", 0); data != "" {
		t.Fatal(data)
	}
	for i := execExits - execTails; i < execExits; i++ {
		id := fmt.Sprint(i)
		if r := tail(id); r["ok"] != true {
			t.Fatal(r)
		}
		if data, _ := p.end(id, 0); data != "data" {
			t.Fatal(data)
		}
	}
}

func TestCheckpointNoChangesDoesNotConnect(t *testing.T) {
	g := fixture(t)
	g.index = &index{Tree: strings.Repeat("a", 40)}
	var thawed bool
	g.freeze = func() (func() error, error) {
		return func() error { thawed = true; return nil }, nil
	}
	// There is deliberately no listener on 5200. A dial-and-retry would time out.
	reply, err := g.checkpoint(context.Background(), request{TimeoutMs: 1000})
	if err != nil || !thawed || reply["changed"] != false || reply["files"] != 0 || reply["bytes"] != 0 || reply["walkMs"] == nil || reply["freezeMs"] == nil {
		t.Fatal(reply, err, thawed)
	}
}

func TestExecStreamedInput(t *testing.T) {
	chunk := bytes.Repeat([]byte{0, 255, 42, 130}, 1<<18)
	for _, tc := range []struct {
		name   string
		chunks int
		size   int64
		code   float64
	}{
		{"large", 33, 33 << 20, 0},
		{"short", 1, 2 << 20, 125},
		{"long", 1, 0, 125},
		{"empty", 0, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := fixture(t)
			t.Cleanup(g.sessions.close)
			digest := sha256.New()
			for range tc.chunks {
				digest.Write(chunk)
			}
			sha := fmt.Sprintf("%x", digest.Sum(nil))
			token := strings.Repeat("a", 32)
			server := streamListener(t, g, hostwire.ExecInputPort, func(c net.Conn) error {
				var got string
				if err := wire.JSON(c, &got); err != nil {
					return err
				}
				if got != token {
					return fmt.Errorf("wrong token: %q", got)
				}
				if err := wire.Send(c, true); err != nil {
					return err
				}
				for range tc.chunks {
					if _, err := c.Write(chunk); err != nil {
						return err
					}
				}
				return nil
			})
			p := sessionPeerFor(t, g)
			const cmd = "wc -c; sha256sum </proc/self/fd/0"
			accepted(t, p.req(message{"op": "exec", "execId": "stream", "command": cmd, "timeoutS": 10,
				"stdinBlob": hostwire.ExecBlob{Blob: strings.Repeat("b", 40), Size: &tc.size, SHA256: sha}, "stdinToken": token}))
			out, exit := p.end("stream", 0)
			if exit["code"] != tc.code {
				t.Fatalf("output %q, exit %v", out, exit)
			}
			err := <-server
			if err != nil && (tc.name != "long" || !errors.Is(err, syscall.EPIPE)) {
				t.Fatal(err)
			}
			if tc.code == 0 {
				want := fmt.Sprintf("%d\n%s  -\n", tc.size, sha)
				if out != want {
					t.Fatalf("got %q, want %q", out, want)
				}
			} else if !strings.Contains(out, "stdin blob stream size mismatch") {
				t.Fatalf("unexpected refusal: %q", out)
			}
		})
	}
}
