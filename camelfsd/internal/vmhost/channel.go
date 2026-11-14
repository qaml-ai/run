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
	"sync"
	"time"
)

const (
	guestLineBytes = 32 << 20
	guestPort      = 5000
	bootDeadline   = 30 * time.Second
)

type Reply map[string]any
type LogFunc func(stream, data string)

// EventFunc receives events for a successful exec or exec_tail request,
// including events that arrive after Request returns. Callbacks run in wire
// order on the channel reader and must return promptly without calling Request.
type EventFunc func(Reply)

type channel struct {
	conn    net.Conn
	in      *bufio.Reader
	busy    chan struct{}
	once    sync.Once
	mu      sync.Mutex
	pending *exchange
	closed  chan struct{}
	err     error
	events  map[string]EventFunc
}

type exchange struct {
	reply  chan Reply
	log    LogFunc
	execID string
	event  EventFunc
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
	return newChannel(conn, reader), nil
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

func newChannel(conn net.Conn, reader *bufio.Reader) *channel {
	return &channel{conn: conn, in: reader, busy: make(chan struct{}, 1), closed: make(chan struct{}), events: make(map[string]EventFunc)}
}

func (c *channel) request(ctx context.Context, req any, onLog LogFunc, events ...EventFunc) (Reply, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.closed:
		return nil, c.err
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
	x := &exchange{reply: make(chan Reply, 1), log: onLog}
	if len(events) > 0 {
		var meta struct{ Op, ExecID string }
		if err := json.Unmarshal(payload, &meta); err != nil {
			return nil, err
		}
		if (meta.Op != "exec" && meta.Op != "exec_tail") || meta.ExecID == "" {
			return nil, errors.New("guest event handler requires exec or exec_tail with an execId")
		}
		x.execID, x.event = meta.ExecID, events[0]
	}
	c.mu.Lock()
	c.pending = x
	c.mu.Unlock()
	c.once.Do(func() { go c.read() })

	// A canceled in-flight request has no response ID to resynchronize on.
	stop := context.AfterFunc(ctx, func() { c.conn.Close() })
	defer stop()
	if _, err := c.conn.Write(append(payload, '\n')); err != nil {
		c.conn.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.closed:
		// An explicit exit can close the connection immediately after its reply.
		select {
		case reply := <-x.reply:
			return reply, nil
		default:
			return nil, c.err
		}
	case reply := <-x.reply:
		return reply, nil
	}
}

func (c *channel) read() {
	defer func() {
		c.conn.Close()
		close(c.closed)
	}()
	for {
		line, err := boundedLine(c.in, guestLineBytes)
		if errors.Is(err, io.EOF) {
			err = errors.New("the guest stopped answering")
		}
		var reply Reply
		if err == nil {
			err = json.Unmarshal(line, &reply)
		}
		if err == nil {
			err = c.route(reply)
		}
		if err != nil {
			c.err = err
			return
		}
	}
}

func (c *channel) route(reply Reply) error {
	c.mu.Lock()
	x := c.pending
	switch reply["event"] {
	case "log":
		c.mu.Unlock()
		if x != nil && x.log != nil {
			stream, _ := reply["stream"].(string)
			data, _ := reply["data"].(string)
			x.log(stream, data)
		}
		return nil
	case "exec_output", "exec_exit", "tail_truncated":
		id, _ := reply["execId"].(string)
		fn := c.events[id]
		if reply["event"] == "exec_exit" {
			delete(c.events, id)
		}
		c.mu.Unlock()
		if fn != nil {
			fn(reply)
		}
		return nil
	}
	defer c.mu.Unlock()
	ok, valid := reply["ok"].(bool)
	if !valid || x == nil {
		return errors.New("invalid guest reply")
	}
	if ok && x.event != nil {
		if reply["execId"] != x.execID {
			return errors.New("invalid guest exec reply")
		}
		c.events[x.execID] = x.event
	}
	c.pending = nil
	x.reply <- reply
	return nil
}
