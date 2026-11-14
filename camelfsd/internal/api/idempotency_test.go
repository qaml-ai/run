package api

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type pausedBody struct {
	started chan struct{}
	resume  chan struct{}
	done    bool
}

func (b *pausedBody) Read(p []byte) (int, error) {
	if b.done {
		return 0, io.EOF
	}
	close(b.started)
	<-b.resume
	b.done = true
	return copy(p, "slow"), nil
}
func TestIdempotencyLocksOnlyMatchingLineageAndKey(t *testing.T) {
	s := storageServer(t, store.Local{Dir: t.TempDir()})
	body := &pausedBody{started: make(chan struct{}), resume: make(chan struct{})}
	defer func() {
		if !body.done {
			close(body.resume)
		}
	}()
	call := func(lineage, key string, body io.Reader) <-chan *httptest.ResponseRecorder {
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			r := httptest.NewRequest("PUT", "/v1/lineages/"+lineage+"/blobs", body)
			r.Header.Set("Authorization", "Bearer test")
			r.Header.Set("Idempotency-Key", key)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			done <- w
		}()
		return done
	}
	slow := call("a", "key", body)
	<-body.started
	duplicate := call("a", "key", strings.NewReader("must not be uploaded"))
	for _, pair := range [][2]string{{"a", "other"}, {"b", "key"}} {
		select {
		case w := <-call(pair[0], pair[1], strings.NewReader("fast")):
			if w.Code != 201 {
				t.Fatal(w.Code, w.Body.String())
			}
		case <-time.After(3 * time.Second):
			t.Fatal("unrelated write blocked behind PUT")
		}
	}
	select {
	case <-duplicate:
		t.Fatal("same key ran before original")
	default:
	}
	close(body.resume)
	first := <-slow
	second := <-duplicate
	if first.Code != 201 || second.Code != 201 || first.Body.String() != second.Body.String() {
		t.Fatal(first, second)
	}
	s.storageServer.idemLocksMu.Lock()
	defer s.storageServer.idemLocksMu.Unlock()
	if len(s.storageServer.idemLocks) != 0 {
		t.Fatal("locks retained after requests")
	}
}
