package delivery

import (
	"fmt"
	"strconv"
	"testing"
	"time"
)

func TestShard(t *testing.T) {
	for id, want := range map[string]string{"": "5", "a": "12", "foobar": "8"} {
		if got := Shard(id); got != want {
			t.Errorf("Shard(%q) = %s, want %s", id, got, want)
		}
	}
	seen := make(map[string]bool)
	for i := range 1000 {
		id := fmt.Sprintf("delivery-%d", i)
		shard := Shard(id)
		n, err := strconv.Atoi(shard)
		if err != nil || n < 0 || n >= Shards || shard != Shard(id) {
			t.Fatalf("invalid or unstable shard for %q: %q", id, shard)
		}
		seen[shard] = true
	}
	if len(seen) != Shards {
		t.Fatalf("used %d shards, want %d", len(seen), Shards)
	}
}

func TestHMAC(t *testing.T) {
	signer := HMAC([]byte("delivery-test-key"))
	got := signer.Sign(time.Unix(1700000000, 999999999), []byte(`{"test":true}`))
	const want = "t=1700000000,v1=2cddc69774fa36576c72f0bff3f7fefb71243b371c9818aeb4e908a9bd162c5e"
	if got != want {
		t.Fatalf("signature = %s, want %s", got, want)
	}
}

func TestBackoff(t *testing.T) {
	for _, tc := range []struct {
		attempts int64
		min, max time.Duration
	}{
		{1, 800 * time.Millisecond, 1200 * time.Millisecond},
		{2, 1600 * time.Millisecond, 2400 * time.Millisecond},
		{3, 3200 * time.Millisecond, 4800 * time.Millisecond},
		{9, 204800 * time.Millisecond, 5 * time.Minute},
		{10, 4 * time.Minute, 5 * time.Minute},
		{1 << 62, 4 * time.Minute, 5 * time.Minute},
	} {
		for range 1000 {
			got := backoff(tc.attempts)
			if got < tc.min || got > tc.max {
				t.Fatalf("backoff(%d) = %s, want [%s, %s]", tc.attempts, got, tc.min, tc.max)
			}
		}
	}
}

func TestStageBodyLimit(t *testing.T) {
	now := time.Unix(1700000000, 0)
	d := Delivery{ID: "body-limit", URL: "https://example.com/hook", Body: make([]byte, 300*1024)}
	if _, err := Stage("deliveries", d, now); err != nil {
		t.Fatal(err)
	}
	d.Body = append(d.Body, 1)
	if _, err := Stage("deliveries", d, now); err == nil {
		t.Fatal("Stage accepted a body over 300 KiB")
	}
}
