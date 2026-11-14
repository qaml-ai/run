// Package guest serves the job host command channel and the camelFS data streams.
package guest

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const (
	streamBytes   = 8 << 20
	outputBytes   = 8 << 20
	logChunkBytes = 16 << 10
)

type message map[string]any

type request struct {
	Op    string
	Files []struct {
		Path   string
		Data   string
		Append bool
	}
	JobID                string
	TimeoutMs            float64
	Tree                 string
	Error                json.RawMessage
	Command              string
	TimeoutSeconds       float64
	Pids                 float64
	Env                  map[string]string
	Outputs              []string
	ExecID, Shell, Stdin string
	TimeoutS             float64
	Offset               int64
	LegacyCheckpoint     bool
}

type guest struct {
	root, repo, out string
	vsock           bool
	uds             string
	send            func(message) error
	reaper          *reaper
	index           *index
	pending         []operation
	freeze          func() (func() error, error)
	sessions        sessionState
	vm              bool
}

func ServeStdio(ctx context.Context, root string) error {
	g := &guest{root: root, uds: os.Getenv("CAMEL_VSOCK_UDS")}
	defer g.sessions.close()
	return serve(ctx, os.Stdin, os.Stdout, g)
}

func serve(ctx context.Context, input io.Reader, output io.Writer, g *guest) error {
	_, err := g.serveChannel(ctx, input, output)
	return err
}

func (g *guest) serveChannel(lifetime context.Context, input io.Reader, output io.Writer) (bool, error) {
	ctx, cancel := context.WithCancel(lifetime)
	defer cancel()
	if g.repo == "" {
		g.repo, g.out = filepath.Join(g.root, "repo"), filepath.Join(g.root, "out")
	}
	enc := json.NewEncoder(output)
	enc.SetEscapeHTML(false)
	var mu sync.Mutex
	channel := &sessionChannel{send: func(m message) error {
		mu.Lock()
		defer mu.Unlock()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if conn, ok := output.(interface{ SetWriteDeadline(time.Time) error }); ok {
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		}
		err := enc.Encode(m)
		if err != nil {
			cancel()
		}
		return err
	}}
	g.send = channel.send
	stop := context.AfterFunc(ctx, func() {
		if c, ok := output.(io.Closer); ok {
			c.Close()
		}
	})
	defer func() { cancel(); stop() }()

	// Keep reading while the command runs so EOF cancels even a silent command.
	lines := make(chan []byte, 1)
	go func() {
		defer close(lines)
		reader := bufio.NewReader(input)
		for {
			line, err := readRequest(reader)
			if err == nil {
				select {
				case lines <- line:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				cancel()
				return
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return false, nil
		case line, ok := <-lines:
			if !ok {
				return false, nil
			}
			if strings.TrimSpace(string(line)) == "" {
				continue
			}
			var req request
			if json.Unmarshal(line, &req) != nil {
				if err := g.send(message{"ok": false, "error": "Invalid request"}); err != nil {
					return false, err
				}
				continue
			}
			if g.sessionRequest(channel, req) {
				continue
			}
			commandCtx := ctx
			if g.vm && req.Op == "run" {
				commandCtx = lifetime
			}
			result, err := g.handle(commandCtx, req)
			if req.Op == "exit" {
				// Once decoded, exit is explicit even if its acknowledgement is lost.
				return true, g.send(message{"ok": true})
			}
			if ctx.Err() != nil {
				return false, nil
			}
			if err != nil {
				result = message{"ok": false, "error": errorText(err)}
			} else {
				result["ok"] = true
			}
			if err := g.send(result); err != nil {
				return false, err
			}
		}
	}
}

func readRequest(r *bufio.Reader) ([]byte, error) {
	const max = 32 << 20
	var line []byte
	for {
		part, err := r.ReadSlice('\n')
		if len(part) > max-len(line) {
			return nil, errors.New("request line too long")
		}
		line = append(line, part...)
		if !errors.Is(err, bufio.ErrBufferFull) {
			return line, err
		}
	}
}

func errorText(err error) string {
	var label string
	switch {
	case errors.Is(err, unix.ENOENT):
		label = "ENOENT"
	case errors.Is(err, unix.EACCES):
		label = "EACCES"
	case errors.Is(err, unix.EPERM):
		label = "EPERM"
	case errors.Is(err, unix.EISDIR):
		label = "EISDIR"
	case errors.Is(err, unix.ENOTDIR):
		label = "ENOTDIR"
	case errors.Is(err, unix.EEXIST):
		label = "EEXIST"
	}
	s := err.Error()
	if label != "" {
		s = label + ": " + s
	}
	return cut(s, 300)
}

func cut(s string, n int) string {
	r := []rune(s)
	return string(r[:min(n, len(r))])
}

func elapsed(t time.Time) int64 { return time.Since(t).Milliseconds() }

func (g *guest) handle(ctx context.Context, req request) (message, error) {
	switch req.Op {
	case "files":
		return g.files(req)
	case "collect":
		return g.collect(req.Outputs)
	case "run":
		return g.run(ctx, req)
	case "free":
		var st unix.Statfs_t
		err := unix.Statfs(g.repo, &st)
		return message{"freeBytes": st.Bavail * uint64(st.Bsize)}, err
	case "camelfs_apply":
		return g.apply(ctx, req)
	case "camelfs_checkpoint":
		return g.checkpoint(ctx, req)
	case "camelfs_checkpointed":
		return g.checkpointed(req)
	case "exit":
		return message{}, nil
	default:
		op := req.Op
		if op == "" {
			op = "undefined"
		}
		return nil, fmt.Errorf("Unknown op %s", cut(op, 40))
	}
}

func inside(root, name string) (string, error) {
	rel := filepath.Clean(strings.TrimLeft(name, "/"))
	if rel == "." || strings.HasPrefix(rel, "..") || strings.ContainsRune(rel, 0) {
		encoded, _ := json.Marshal(name)
		return "", fmt.Errorf("Invalid path: %s", cut(string(encoded), 200))
	}
	return filepath.Join(root, rel), nil
}

func (g *guest) files(req request) (message, error) {
	start := time.Now()
	for _, dir := range []string{g.repo, g.out} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return nil, err
		}
	}
	for _, item := range req.Files {
		path, err := inside(g.repo, item.Path)
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return nil, err
		}
		// Buffer.from accepts unpadded and URL-safe base64 and ignores non-alphabet bytes.
		data := strings.Map(func(r rune) rune {
			switch {
			case r == '-':
				return '+'
			case r == '_':
				return '/'
			case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '+', r == '/':
				return r
			default:
				return -1
			}
		}, strings.SplitN(item.Data, "=", 2)[0])
		decoded, _ := base64.RawStdEncoding.DecodeString(data)
		flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
		if item.Append {
			flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
		}
		f, err := os.OpenFile(path, flags, 0666)
		if err != nil {
			return nil, err
		}
		_, err = f.Write(decoded)
		if err = errors.Join(err, f.Close()); err != nil {
			return nil, err
		}
	}
	return message{"syncMs": elapsed(start)}, nil
}

type stream struct {
	Data      string `json:"data"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
}

func captured(b []byte, size int64) stream {
	return stream{base64.StdEncoding.EncodeToString(b), size, size > int64(len(b))}
}

func (g *guest) collect(names []string) (message, error) {
	start := time.Now()
	outputs := map[string]stream{}
	missing := []string{}
	room := int64(outputBytes)
	for _, name := range names {
		path, err := inside(g.out, name)
		if err != nil {
			return nil, err
		}
		st, err := os.Stat(path)
		if err != nil || !st.Mode().IsRegular() {
			missing = append(missing, name)
			continue
		}
		f, err := os.OpenFile(path, os.O_RDONLY|unix.O_NONBLOCK, 0)
		if err != nil {
			missing = append(missing, name)
			continue
		}
		b, err := io.ReadAll(io.LimitReader(f, room))
		f.Close()
		if err != nil {
			missing = append(missing, name)
			continue
		}
		outputs[name] = captured(b, st.Size())
		room -= int64(len(b))
	}
	return message{"outputs": outputs, "missing": missing, "collectMs": elapsed(start)}, nil
}
