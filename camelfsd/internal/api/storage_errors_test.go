package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"log"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStorageErrorsDistinguishIOFromInternal(t *testing.T) {
	var logs bytes.Buffer
	old := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(old)
	local := store.Local{Dir: t.TempDir()}
	_, missingIO := local.Get(context.Background(), "t/"+strings.Repeat("a", 40))
	if !errors.Is(missingIO, store.ErrUnavailable) {
		t.Fatal(missingIO)
	}
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{fmt.Errorf("broken invariant"), 500, "internal"},
		{fmt.Errorf("wrapped: %w", missingIO), 503, "unavailable"},
		{fmt.Errorf("invalid cache row"), 500, "internal"},
	} {
		w := httptest.NewRecorder()
		storageFail(w, tc.err)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.code) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if !strings.Contains(logs.String(), "broken invariant") || !strings.Contains(logs.String(), "invalid cache row") {
		t.Fatal("internal failures were not logged")
	}
	// Invalid object keys are bugs, not store unavailability.
	_, e := local.Get(context.Background(), "bad-key")
	if errors.Is(e, store.ErrUnavailable) {
		t.Fatal(e)
	}
}
