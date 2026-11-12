package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestGenerator(t *testing.T) {
	a, b, c := make([]byte, 256*1024), make([]byte, 256*1024), make([]byte, 256*1024)
	fillChunk(a, 1, 7)
	fillChunk(b, 1, 7)
	fillChunk(c, 1, 8)
	if !bytes.Equal(a, b) || bytes.Equal(a, c) {
		t.Fatal("determinism or chunk independence")
	}
	if bytes.Equal(a[8:1024], c[:1016]) {
		t.Fatal("neighboring chunks share a shifted stream")
	}
	fillChunk(c, 2, 7)
	if bytes.Equal(a, c) {
		t.Fatal("seed independence")
	}
	fillChunk(c[:123], 1, 7)
	if !bytes.Equal(a[:123], c[:123]) {
		t.Fatal("prefix consistency")
	}
	// Pin the byte stream so generator changes cannot silently invalidate uploads.
	if got := fmt.Sprintf("%x", a[:8]); got != "8737ea6ec924c357" {
		t.Fatalf("chunk 7 prefix changed: %s", got)
	}
}
func TestSubset(t *testing.T) {
	a := neededChunks(101, .1, 7)
	b := neededChunks(101, .1, 7)
	if len(a) != 11 || !reflect.DeepEqual(a, b) {
		t.Fatal(a, b)
	}
	seen := map[int]bool{}
	for _, i := range a {
		if i < 0 || i >= 101 || seen[i] {
			t.Fatal(a)
		}
		seen[i] = true
	}
	if reflect.DeepEqual(a, neededChunks(101, .1, 8)) {
		t.Fatal("seed ignored")
	}
	all := neededChunks(10, 1, 1)
	for i, v := range all {
		if i != v {
			t.Fatal(all)
		}
	}
}
func TestPlans(t *testing.T) {
	const size = 256 * 1024
	for _, tc := range []struct {
		mode string
		pp   int
	}{{"chunk", 1}, {"pack1m", 4}, {"pack4m", 16}} {
		t.Run(tc.mode, func(t *testing.T) {
			rs, err := plan("prefix/", tc.mode, 35, size, []int{0, 1, 17, 34})
			if err != nil {
				t.Fatal(err)
			}
			seen := map[int]bool{}
			for _, i := range []int{0, 1, 17, 34} {
				seen[i/tc.pp] = true
			}
			if len(rs) != len(seen) {
				t.Fatal(rs)
			}
			for _, r := range rs {
				p := r.first / tc.pp
				if !seen[p] || r.first != p*tc.pp || r.size != r.count*size || r.count != min(tc.pp, 35-r.first) || r.key != objectKey("prefix", tc.mode, p) {
					t.Fatal(r)
				}
			}
		})
	}
	rs, err := plan("p", "range4m", 35, size, []int{0, 15, 16, 34})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"bytes=0-262143", "bytes=3932160-4194303", "bytes=0-262143", "bytes=524288-786431"}
	for i, r := range rs {
		if r.byteRange != want[i] || r.size != size || r.count != 1 || r.first != []int{0, 15, 16, 34}[i] {
			t.Fatal(r)
		}
	}
	if rs[2].key != "p/pack4m/00000001" {
		t.Fatal(rs[2])
	}
	if _, err = perPack("pack1m", 300*1024); err == nil {
		t.Fatal("indivisible chunk size")
	}
	pp, err := perPack("pack4m", 512*1024)
	if err != nil || pp != 8 {
		t.Fatal(pp, err)
	}
}
func TestReadRetriesAndVerification(t *testing.T) {
	var calls atomic.Int64
	payload := make([]byte, 1024)
	fillChunk(payload, 1, 0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(503)
			fmt.Fprint(w, "<Error><Code>SlowDown</Code></Error>")
			return
		}
		w.Header().Set("Content-Length", "1024")
		w.Write(payload)
	}))
	defer server.Close()
	counter := &countingClient{client: awshttp.NewBuildableClient()}
	counter.active.Store(true)
	c := s3.New(s3.Options{Region: "us-west-2", BaseEndpoint: aws.String(server.URL), UsePathStyle: true, HTTPClient: counter, Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{AccessKeyID: "test", SecretAccessKey: "test"}, nil
	})})
	r := request{key: "chunk/00000000", size: 1024, count: 1}
	buf := make([]byte, 1024)
	m, err := get(context.Background(), c, "bucket", r, buf)
	if err != nil {
		t.Fatal(err)
	}
	if m.bytes != 1024 || m.ttfb > m.latency || counter.attempts.Load() != 2 || counter.status503.Load() != 1 {
		t.Fatal(m, counter.attempts.Load(), counter.status503.Load())
	}
	if err = verify(buf, make([]byte, 1024), r, 1024, 1); err != nil {
		t.Fatal(err)
	}
	buf[0] ^= 1
	if err = verify(buf, make([]byte, 1024), r, 1024, 1); err == nil {
		t.Fatal("corruption accepted")
	}
}

func TestAttemptCounterExcludesCredentialAndSessionCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer server.Close()
	counter := &countingClient{client: awshttp.NewBuildableClient()}
	counter.active.Store(true)
	for _, tc := range []struct{ path, auth string }{
		{"/latest/meta-data/iam/security-credentials/role", ""},
		{"/?session", "AWS4-HMAC-SHA256 test"},
		{"/chunk/00000000", "AWS4-HMAC-SHA256 test"},
	} {
		req, err := http.NewRequest(http.MethodGet, server.URL+tc.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", tc.auth)
		resp, err := counter.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	if counter.attempts.Load() != 1 || counter.status503.Load() != 1 {
		t.Fatal("counted credential or session requests")
	}
}
