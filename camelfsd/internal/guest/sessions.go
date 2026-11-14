package guest

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

const (
	execTails = 8
	execExits = 64
	tailBytes = 1 << 20
)

type sessionChannel struct {
	send func(message) error
}

type sessionState struct {
	mu     sync.Mutex
	shells map[string]*shell
	execs  map[string]*execution
	tails  []*execution
	exits  []*execution
}

type execution struct {
	id         string
	args       [32]byte
	next       int64
	chunks     []outputChunk
	keepTail   bool
	keepExit   bool
	exit       message
	subscriber *sessionChannel
}

type outputChunk struct {
	offset int64
	stream string
	data   []byte
}

func failure(code string) message { return message{"ok": false, "code": code} }

func (g *guest) sessionRequest(c *sessionChannel, req request) bool {
	s := &g.sessions
	switch req.Op {
	case "shell_open", "sessions", "exec", "exec_tail":
	default:
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch req.Op {
	case "shell_open":
		sh, err := g.openShell()
		if err != nil {
			c.send(message{"ok": false, "error": errorText(err)})
			break
		}
		if s.shells == nil {
			s.shells = make(map[string]*shell)
		}
		s.shells[sh.id] = sh
		go func() {
			<-sh.done
			s.mu.Lock()
			delete(s.shells, sh.id)
			if !sh.busy {
				sh.status.Close()
			}
			s.mu.Unlock()
		}()
		c.send(message{"ok": true, "shellId": sh.id})
	case "sessions":
		shells := []string{}
		for id := range s.shells {
			shells = append(shells, id)
		}
		execs := []message{}
		for _, e := range s.execs {
			m := message{"execId": e.id, "running": e.exit == nil, "nextOffset": e.next}
			if e.exit != nil {
				m["exit"] = e.exit
			}
			execs = append(execs, m)
		}
		reply := message{"ok": true, "shells": shells, "execs": execs}
		if g.session && g.index != nil {
			reply["tree"] = g.index.Tree
			reply["checkpointPending"] = g.pending != nil
		}
		c.send(reply)
	case "exec_tail":
		e := s.execs[req.ExecID]
		switch {
		case e == nil:
			c.send(failure("exec_unknown"))
		case req.Offset < 0 || req.Offset > e.next:
			c.send(failure("invalid_offset"))
		default:
			e.attach(c, message{"ok": true, "execId": e.id}, req.Offset)
		}
	case "exec":
		g.acceptExec(c, req)
	}
	return true
}

// acceptExec runs with the session lock held. The digest preserves identity
// after completion without retaining command text, environment, or stdin.
func (g *guest) acceptExec(c *sessionChannel, req request) {
	s := &g.sessions
	if req.ExecID == "" {
		c.send(failure("invalid_exec_id"))
		return
	}
	if len(req.Env) == 0 {
		req.Env = nil
	}
	args, _ := json.Marshal([]any{req.Command, req.Shell, req.Env, req.Stdin, req.Cwd})
	digest := sha256.Sum256(args)
	ack := message{"ok": true, "execId": req.ExecID, "accepted": true}
	if e := s.execs[req.ExecID]; e != nil {
		if e.args != digest {
			c.send(failure("exec_conflict"))
			return
		}
		e.attach(c, ack, 0)
		return
	}
	var sh *shell
	if req.Shell != "" {
		sh = s.shells[req.Shell]
		if sh == nil {
			c.send(failure("shell_unknown"))
			return
		}
		if sh.busy {
			c.send(failure("shell_busy"))
			return
		}
		sh.busy = true
	}
	e := &execution{id: req.ExecID, args: digest, keepTail: true}
	if s.execs == nil {
		s.execs = make(map[string]*execution)
	}
	s.execs[e.id] = e
	s.tails = append(s.tails, e)
	if len(s.tails) > execTails {
		old := s.tails[0]
		s.tails = s.tails[1:]
		old.keepTail, old.chunks = false, nil
		s.evict(old)
	}
	// Registration precedes acknowledgement and execution. Even a failed ack
	// leaves the accepted command running so a retry can recover its result.
	e.attach(c, ack, 0)
	go g.execute(e, sh, req)
}

func (e *execution) attach(c *sessionChannel, ack message, offset int64) {
	first := e.next
	if len(e.chunks) > 0 {
		first = e.chunks[0].offset
	}
	ack["firstOffset"] = first
	if err := c.send(ack); err != nil {
		return
	}
	if offset < first {
		c.send(message{"event": "tail_truncated", "execId": e.id, "firstOffset": first})
		offset = first
	}
	for _, chunk := range e.chunks {
		skip := max(0, offset-chunk.offset)
		if skip < int64(len(chunk.data)) {
			if err := e.sendChunk(c, chunk.stream, chunk.offset+skip, chunk.data[skip:]); err != nil {
				return
			}
		}
	}
	if e.exit != nil {
		c.send(e.exit)
	} else {
		e.subscriber = c
	}
}

func (e *execution) sendChunk(c *sessionChannel, stream string, offset int64, data []byte) error {
	return c.send(message{"event": "exec_output", "execId": e.id, "stream": stream, "offset": offset, "data": data})
}

func (s *sessionState) output(e *execution, stream string, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	offset := e.next
	e.next += int64(len(data))
	if e.keepTail {
		e.chunks = append(e.chunks, outputChunk{offset, stream, append([]byte(nil), data...)})
		for len(e.chunks) > 0 && e.next-e.chunks[0].offset > tailBytes {
			e.chunks[0] = outputChunk{}
			e.chunks = e.chunks[1:]
		}
	}
	if c := e.subscriber; c != nil {
		if err := e.sendChunk(c, stream, offset, data); err != nil {
			e.subscriber = nil
		}
	}
}

func (g *guest) execute(e *execution, sh *shell, req request) {
	start := time.Now()
	code, timedOut, err := g.sessionCommand(e, sh, req)
	s := &g.sessions
	if err != nil {
		s.output(e, "stderr", []byte(fmt.Sprintf("exec: %s\n", errorText(err))))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if sh != nil {
		sh.busy = false
		select {
		case <-sh.done:
			delete(s.shells, sh.id)
			sh.status.Close()
		default:
		}
	}
	e.exit = message{"event": "exec_exit", "execId": e.id, "code": code, "timedOut": timedOut, "ms": elapsed(start)}
	e.keepExit = true
	s.exits = append(s.exits, e)
	if len(s.exits) > execExits {
		old := s.exits[0]
		s.exits = s.exits[1:]
		old.keepExit = false
		s.evict(old)
	}
	if c := e.subscriber; c != nil {
		c.send(e.exit)
		e.subscriber = nil
	}
}

func (s *sessionState) evict(e *execution) {
	if e.exit != nil && !e.keepExit && !e.keepTail {
		delete(s.execs, e.id)
	}
}

func (s *sessionState) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sh := range s.shells {
		sh.kill()
	}
}
