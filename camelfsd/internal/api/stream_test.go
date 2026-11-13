package api

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type streamingStore struct {
	store.Store
	local store.Local
	opens int
}

func (s *streamingStore) Get(ctx context.Context, key string) ([]byte, error) {
	if strings.HasPrefix(key, "o/") {
		return nil, fmt.Errorf("large blob used buffered Get")
	}
	return s.Store.Get(ctx, key)
}
func (s *streamingStore) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	s.opens++
	return s.local.Open(ctx, key)
}
func TestLargeBlobStreamsToFileWithRangeAndCleanup(t *testing.T) {
	local := store.Local{Dir: t.TempDir()}
	s := storageServer(t, local)
	raw := bytes.Repeat([]byte("large file\n"), (9<<20)/11+1)
	blob := put(t, s, "l", string(raw))
	tree := commit(t, s, "l", "", []change{{Path: "large", Blob: blob}})["tree"].(string)
	st := &streamingStore{Store: local, local: local}
	s.Manager.Store = st
	r := httptest.NewRequest("GET", "/v1/lineages/l/blobs/"+blob+"?tree="+tree+"&path=large", nil)
	r.Header.Set("Authorization", "Bearer test")
	r.Header.Set("Range", "bytes=3-14")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != string(raw[3:15]) || w.Header().Get("X-Camel-Size") != fmt.Sprint(len(raw)) || st.opens != 1 {
		t.Fatal(w.Code, w.Body.String(), st.opens)
	}
	var count int
	s.repository().DB.DB.QueryRow("SELECT count(*) FROM objects WHERE id=? AND kind='blob'", blob).Scan(&count)
	if count != 0 {
		t.Fatal("large blob cached inline")
	}
	files, _ := filepath.Glob(filepath.Join(s.Manager.Data, "camelfsd-read-*"))
	if len(files) != 0 {
		t.Fatal(files)
	}
	// A failed verification must also remove the temporary download.
	if e := os.WriteFile(filepath.Join(local.Dir, "o", blob), []byte("broken"), 0600); e != nil {
		t.Fatal(e)
	}
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code < 500 {
		t.Fatal(w.Code)
	}
	files, _ = filepath.Glob(filepath.Join(s.Manager.Data, "camelfsd-read-*"))
	if len(files) != 0 {
		t.Fatal(files)
	}
}
