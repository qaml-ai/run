package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/image"
)

func TestHydrationStats(t *testing.T) {
	m := &image.Manager{Cache: &cache.Cache{}}
	m.PrehydrateBytes.Store(524288)
	m.Cache.ReflinkedChunks.Store(2)
	s := &Server{Manager: m}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/v0/stats", nil))
	var got map[string]int64
	if e := json.Unmarshal(w.Body.Bytes(), &got); e != nil {
		t.Fatal(e)
	}
	if w.Code != 200 || got["prehydrateBytes"] != 524288 || got["reflinkedChunks"] != 2 {
		t.Fatal(w.Code, got)
	}
}
