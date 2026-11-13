package wire

import (
	"net"
	"time"
)

// DeadlineConn resets the idle budget at frame boundaries, bounded by Overall.
type DeadlineConn struct {
	net.Conn
	Idle    time.Duration
	Overall time.Time
}

func (c *DeadlineConn) FrameProgress() {
	d := time.Now().Add(c.Idle)
	if c.Overall.Before(d) {
		d = c.Overall
	}
	c.Conn.SetDeadline(d)
}

// Final gives a nack/error trailer a fresh, bounded write budget.
func (c *DeadlineConn) Final() { c.Conn.SetWriteDeadline(time.Now().Add(time.Second)) }
func progress(v any) {
	if p, ok := v.(interface{ FrameProgress() }); ok {
		p.FrameProgress()
	}
}
