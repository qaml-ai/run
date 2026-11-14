package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

var sessionFrames = []string{
	"event: stdout\r\ndata: {\"data\":\"YQ==\",\"offset\":0}\r\n\r\n",
	"event: stderr\ndata: {\"data\":\"Yg==\",\"offset\":1}\n\n",
	"event: stdout\ndata: {\"data\":\"Yw==\",\"offset\":2}\n\n",
	"event: exit\ndata: {\"code\":0,\"timedOut\":false,\"ms\":20}\n\n",
}

type frameWriter struct {
	*httptest.ResponseRecorder
	flushed chan string
}

func (w frameWriter) Flush() {
	w.flushed <- w.Body.String()
	w.Body.Reset()
}

func TestUnitVMExecStream(t *testing.T) {
	reader, host := io.Pipe()
	defer reader.Close()
	defer host.Close()
	w := frameWriter{httptest.NewRecorder(), make(chan string)}
	r := httptest.NewRequest("POST", "/exec", nil).WithContext(t.Context())
	resp := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: reader}
	exit := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- streamHostEvents(w, r, resp, func() { close(exit) }, t.Context()) }()
	for i, frame := range sessionFrames {
		// The next host frame is withheld until the client receives this flush.
		if _, err := io.WriteString(host, frame); err != nil {
			t.Fatal(err)
		}
		if got := <-w.flushed; got != frame {
			t.Fatalf("frame %d: got %q, want %q", i, got, frame)
		}
	}
	host.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	select {
	case <-exit:
	default:
		t.Fatal("exit was not observed")
	}
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("response: %d %v", w.Code, w.Header())
	}
}

// A command that prints nothing keeps its stream open with comment frames (the public ALB drops a connection idle
// for 60 s), and a comment never splits a host frame.
func TestUnitVMExecStreamKeepalive(t *testing.T) {
	previous := execKeepalive
	execKeepalive = 10 * time.Millisecond
	defer func() { execKeepalive = previous }()
	reader, host := io.Pipe()
	defer reader.Close()
	w := frameWriter{httptest.NewRecorder(), make(chan string)}
	r := httptest.NewRequest("POST", "/exec", nil).WithContext(t.Context())
	resp := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: reader}
	done := make(chan error, 1)
	go func() { done <- streamHostEvents(w, r, resp, func() {}, t.Context()) }()
	// Quiet: only keepalives arrive.
	for i := 0; i < 3; i++ {
		if got := <-w.flushed; got != ": keepalive\n\n" {
			t.Fatalf("quiet flush %d: %q", i, got)
		}
	}
	// Frames then arrive whole between keepalives, in order.
	go func() {
		for _, frame := range sessionFrames {
			_, _ = io.WriteString(host, frame)
		}
		host.Close()
	}()
	var frames []string
	for len(frames) < len(sessionFrames) {
		got := <-w.flushed
		if got == ": keepalive\n\n" {
			continue
		}
		frames = append(frames, got)
	}
	for i, frame := range sessionFrames {
		if frames[i] != frame {
			t.Fatalf("frame %d: got %q, want %q", i, frames[i], frame)
		}
	}
	for {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
			return
		case <-w.flushed:
		}
	}
}
