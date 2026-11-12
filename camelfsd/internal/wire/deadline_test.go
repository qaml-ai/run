package wire

import (
	"net"
	"testing"
	"time"
)

func TestProgressDeadline(t *testing.T) {
	for _, moving := range []bool{false, true} {
		a, b := net.Pipe()
		c := &DeadlineConn{Conn: a, Idle: 40 * time.Millisecond, Overall: time.Now().Add(time.Second)}
		done := make(chan error, 1)
		go func() {
			for i := 0; i < 5; i++ {
				if _, e := Read(c, 100); e != nil {
					c.Final()
					Send(a, map[string]bool{"ack": false})
					done <- e
					return
				}
			}
			done <- nil
		}()
		if moving {
			for i := 0; i < 5; i++ {
				time.Sleep(20 * time.Millisecond)
				if e := Send(b, i); e != nil {
					t.Fatal(e)
				}
			}
		} else {
			time.Sleep(80 * time.Millisecond)
			var nack map[string]bool
			if e := JSON(b, &nack); e != nil || nack["ack"] {
				t.Fatalf("nack=%v error=%v", nack, e)
			}
		}
		e := <-done
		if moving && e != nil || !moving && e == nil {
			t.Fatal(e)
		}
		a.Close()
		b.Close()
	}
}
