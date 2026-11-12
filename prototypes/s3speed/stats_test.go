package main

import (
	"math"
	"testing"
	"time"
)

func TestPercentile(t *testing.T) {
	values := []time.Duration{5 * time.Millisecond, time.Millisecond, 4 * time.Millisecond, 2 * time.Millisecond, 3 * time.Millisecond}
	for _, tc := range []struct{ p, want float64 }{{.5, 3}, {.9, 5}, {.99, 5}, {1, 5}, {.2, 1}, {0, 1}} {
		if got := percentile(values, tc.p); got != tc.want {
			t.Fatalf("%g: got %g want %g", tc.p, got, tc.want)
		}
	}
	if values[0] != 5*time.Millisecond {
		t.Fatal("mutated input")
	}
	if percentile(nil, .5) != 0 {
		t.Fatal("empty")
	}
}
func TestCost(t *testing.T) {
	p := prices{.0004, .00003, .0006}
	for _, tc := range []struct {
		name     string
		express  bool
		attempts int64
		sizes    []int64
		want     float64
	}{
		{"standard", false, 1000, []int64{4 << 20}, .0004},
		{"threshold", true, 1000, []int64{0, 262144, 524288}, .00003},
		{"one byte beyond", true, 1, []int64{524289}, .00003/1000 + .0006/1e9},
		{"per request", true, 3, []int64{1 << 20, 4 << 20}, 3*.00003/1000 + float64((1<<20)-524288+(4<<20)-524288)/1e9*.0006},
		{"retry request charge", true, 2, []int64{262144}, 2 * .00003 / 1000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := estimateCost(tc.express, tc.attempts, tc.sizes, p)
			if math.Abs(got-tc.want) > 1e-15 {
				t.Fatalf("got %.15g want %.15g", got, tc.want)
			}
		})
	}
}
