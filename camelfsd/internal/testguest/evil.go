package testguest

import (
	"encoding/binary"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"net"
	"strings"
	"time"
)

// Evil sends one intentional protocol violation. The caller arms the host first.
func Evil(c net.Conn, which, job, base string) error {
	if which == "unarmed" {
		var b [1]byte
		_, e := c.Read(b[:])
		return e
	}
	var ready struct {
		Ready bool `json:"ready"`
	}
	if e := wire.JSON(c, &ready); e != nil {
		return e
	}
	if !ready.Ready {
		return fmt.Errorf("no ready")
	}
	if which == "stall" {
		time.Sleep(2 * time.Second)
		return nil
	}
	if which == "oversized-frame" {
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], 2<<20)
		_, e := c.Write(b[:])
		return e
	}
	if which == "oversized-json" {
		return wire.Write(c, []byte(strings.Repeat(" ", wire.JSONMax+1)))
	}
	h := wire.Header{V: 1, Kind: "checkpoint", JobID: job, BaseTree: base}
	if which == "wrong-job" {
		h.JobID = "wrong"
	}
	if which == "wrong-base" {
		h.BaseTree = "wrong"
	}
	if e := wire.Send(c, h); e != nil {
		return e
	}
	o := wire.Op{Path: "x", Op: "put", Mode: "100644"}
	switch which {
	case "dotdot":
		o.Path = "../x"
	case "git":
		o.Path = ".git/x"
	case "absolute":
		o.Path = "/x"
	case "nul":
		o.Path = "a\x00b"
	case "component":
		o.Path = strings.Repeat("a", 256)
	case "bad-mode":
		o.Mode = "777"
	case "long-link":
		o.Op = "link"
		o.Target = strings.Repeat("x", 4097)
	case "size-more":
		o.Size = 1
	case "size-less":
		o.Size = 2
	case "max-bytes":
		o.Size = 9 << 30
	}
	if e := wire.Send(c, o); e != nil {
		return e
	}
	if which == "size-more" {
		wire.Write(c, []byte("xx"))
	}
	if which == "size-less" {
		wire.Write(c, []byte("x"))
	}
	if which == "duplicate" {
		wire.Send(c, o)
	}
	if which == "file-dir" {
		o.Path = "x/y"
		wire.Send(c, o)
	}
	if which == "max-files" {
		o.Path = "y"
		wire.Send(c, o)
	}
	if which == "max-paths" {
		o.Path = "long-path"
		wire.Send(c, o)
	}
	return wire.Send(c, wire.Op{End: true, Files: 1})
}
