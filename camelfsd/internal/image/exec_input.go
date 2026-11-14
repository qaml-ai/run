package image

import (
	"io"
	"net"
	"os"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

// OfferExecInput makes the verified file available to a single connection from
// this VM. The caller owns the reader until it withdraws the offer.
func (m *Manager) OfferExecInput(id, token string, src io.Reader) (func(), error) {
	v := m.lookup(id)
	if v == nil {
		return nil, os.ErrNotExist
	}
	v.mu.Lock()
	s := v.streams
	v.mu.Unlock()
	if s == nil {
		return nil, os.ErrNotExist
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, os.ErrNotExist
	}
	if s.execInputs == nil {
		s.execInputs = make(map[string]io.Reader)
	}
	s.execInputs[token] = src
	return func() {
		s.mu.Lock()
		delete(s.execInputs, token)
		s.mu.Unlock()
	}, nil
}

func (s *streams) sendExecInput(raw net.Conn, idle, max time.Duration) {
	defer raw.Close()
	defer func() {
		s.mu.Lock()
		delete(s.conns, raw)
		s.mu.Unlock()
	}()
	deadline := time.Now().Add(max)
	c := &wire.DeadlineConn{Conn: raw, Idle: idle, Overall: deadline}
	var token string
	if err := wire.JSON(c, &token); err != nil {
		return
	}
	s.mu.Lock()
	src := s.execInputs[token]
	delete(s.execInputs, token)
	s.mu.Unlock()
	if src == nil || wire.Send(c, true) != nil {
		return
	}
	if raw.SetWriteDeadline(deadline) == nil {
		_, _ = io.Copy(raw, src)
	}
}
