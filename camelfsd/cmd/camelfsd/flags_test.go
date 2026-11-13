package main

import (
	"strings"
	"testing"
)

func TestColdFlagRemoved(t *testing.T) {
	if e := host([]string{"--cold=prehydrate"}); e == nil || !strings.Contains(e.Error(), "flag provided but not defined") {
		t.Fatal(e)
	}
}
