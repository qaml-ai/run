package api

import (
	"encoding/json"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"net/http/httptest"
	"testing"
)

func TestStatsPackBytes(t *testing.T) {
	m := &image.Manager{Cache: &cache.Cache{}}
	m.PackBytes.Store(4 << 20)
	s := &Server{Manager: m}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/v0/stats", nil))
	var got map[string]int64
	if e := json.Unmarshal(w.Body.Bytes(), &got); e != nil || w.Code != 200 || got["packBytes"] != 4<<20 {
		t.Fatal(w.Code, got, e)
	}
}
