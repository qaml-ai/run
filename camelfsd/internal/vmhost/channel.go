package vmhost

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	guestLineBytes = 32 << 20
	guestPort      = 5000
	bootDeadline   = 30 * time.Second
)

type Reply map[string]any
type LogFunc func(stream, data string)

type channel struct {
	conn net.Conn
	in   *bufio.Reader
	busy chan struct{}
}

var connectOK = regexp.MustCompile(`^OK [0-9]+$`)

func connectGuest(ctx context.Context, path string, timeout time.Duration) (*channel, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var last error
	for ctx.Err() == nil {
		// A stalled handshake gets another attempt within the overall deadline.
		attempt, stop := context.WithTimeout(ctx, 500*time.Millisecond)
		c, err := openGuest(attempt, path)
		stop()
		if err == nil {
			return c, nil
		}
		last = err
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	return nil, fmt.Errorf("the VM did not answer on vsock in %s: %w", timeout, errors.Join(ctx.Err(), last))
}

func openGuest(ctx context.Context, path string) (*channel, error) {
	// The pathname passed to connect must fit sockaddr_un even with a long work path or job ID.
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	shortPath := fmt.Sprintf("/proc/self/fd/%d/%s", dir.Fd(), filepath.Base(path))
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", shortPath)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			conn.Close()
		}
	}()
	if deadline, set := ctx.Deadline(); set {
		if err := conn.SetDeadline(deadline); err != nil {
			return nil, err
		}
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if _, err := fmt.Fprintf(conn, "CONNECT %d\n", guestPort); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(conn)
	line, err := boundedLine(reader, guestLineBytes)
	if err != nil {
		return nil, err
	}
	if !connectOK.MatchString(strings.TrimSpace(string(line))) {
		return nil, errors.New("vsock refused CONNECT")
	}
	if !stop() {
		return nil, ctx.Err()
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	ok = true
	return &channel{conn: conn, in: reader, busy: make(chan struct{}, 1)}, nil
}

func boundedLine(in *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	for {
		part, err := in.ReadSlice('\n')
		if err == nil {
			part = part[:len(part)-1]
		}
		if len(part) > limit-len(line) {
			return nil, fmt.Errorf("the guest sent a line over %d bytes", limit)
		}
		line = append(line, part...)
		if !errors.Is(err, bufio.ErrBufferFull) {
			return line, err
		}
	}
}

func (c *channel) request(ctx context.Context, req any, onLog LogFunc) (Reply, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case c.busy <- struct{}{}:
	}
	defer func() { <-c.busy }()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	// A canceled in-flight request has no response ID to resynchronize on.
	stop := context.AfterFunc(ctx, func() { c.conn.Close() })
	defer stop()
	reply, err := c.exchange(payload, onLog)
	if err != nil {
		c.conn.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return reply, err
}

func (c *channel) exchange(payload []byte, onLog LogFunc) (Reply, error) {
	if _, err := c.conn.Write(append(payload, '\n')); err != nil {
		return nil, err
	}
	for {
		line, err := boundedLine(c.in, guestLineBytes)
		if errors.Is(err, io.EOF) {
			return nil, errors.New("the guest stopped answering")
		}
		if err != nil {
			return nil, err
		}
		var reply Reply
		if err := json.Unmarshal(line, &reply); err != nil {
			return nil, err
		}
		if reply["event"] == "log" {
			if onLog != nil {
				stream, _ := reply["stream"].(string)
				data, _ := reply["data"].(string)
				onLog(stream, data)
			}
			continue
		}
		if _, ok := reply["ok"].(bool); !ok {
			return nil, errors.New("invalid guest reply")
		}
		return reply, nil
	}
}
