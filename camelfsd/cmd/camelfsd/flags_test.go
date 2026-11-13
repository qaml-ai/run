package main

import (
	"strings"
	"testing"
)

func TestHostRejectsRemovedColdFlag(t *testing.T) {
	err := host([]string{"--cold", "prehydrate"})
	if err == nil || !strings.Contains(err.Error(), "flag provided but not defined: -cold") {
		t.Fatalf("removed cold flag: %v", err)
	}
}
