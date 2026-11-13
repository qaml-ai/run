// Package wire implements bounded camelfsd guest frames.
package wire

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"unicode/utf8"
)

const JSONMax = 64 << 10
const DataMax = 1 << 20

func Read(r io.Reader, max int) ([]byte, error) {
	progress(r)
	defer progress(r)
	var h [4]byte
	if _, e := io.ReadFull(r, h[:]); e != nil {
		return nil, e
	}
	n := binary.BigEndian.Uint32(h[:])
	if n == 0 || n > DataMax+JSONMax || n > uint32(max) {
		return nil, fmt.Errorf("frame length %d exceeds limit", n)
	}
	b := make([]byte, int(n))
	_, e := io.ReadFull(r, b)
	return b, e
}
func JSON(r io.Reader, v any) error {
	b, e := Read(r, JSONMax)
	if e != nil {
		return e
	}
	if !utf8.Valid(b) {
		return fmt.Errorf("invalid UTF-8 JSON")
	}
	return json.Unmarshal(b, v)
}
func Write(w io.Writer, b []byte) error {
	progress(w)
	defer progress(w)
	var h [4]byte
	binary.BigEndian.PutUint32(h[:], uint32(len(b)))
	if _, e := w.Write(h[:]); e != nil {
		return e
	}
	_, e := w.Write(b)
	return e
}
func Send(w io.Writer, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if len(b) > JSONMax {
		return fmt.Errorf("JSON frame too large")
	}
	return Write(w, b)
}

type Header struct {
	V        int     `json:"v"`
	Kind     string  `json:"kind"`
	JobID    string  `json:"jobId"`
	BaseTree string  `json:"baseTree,omitempty"`
	FromTree string  `json:"fromTree,omitempty"`
	ToTree   string  `json:"toTree,omitempty"`
	WalkMs   float64 `json:"walkMs,omitempty"`
}
type Op struct {
	Path     string  `json:"path"`
	Op       string  `json:"op"`
	Mode     string  `json:"mode,omitempty"`
	Size     int64   `json:"size,omitempty"`
	Target   string  `json:"target,omitempty"`
	End      bool    `json:"end,omitempty"`
	Files    int     `json:"files,omitempty"`
	Bytes    int64   `json:"bytes,omitempty"`
	FreezeMs float64 `json:"freezeMs,omitempty"`
	Skipped  int     `json:"skipped,omitempty"`
	Error    string  `json:"error,omitempty"`
}
