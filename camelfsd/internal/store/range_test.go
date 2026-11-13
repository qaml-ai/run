package store

import (
	"bytes"
	"context"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestS3RangeHeader(t *testing.T) {
	payload := bytes.Repeat([]byte{42}, int(root.ChunkSize))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Range"); got != "bytes=262144-524287" {
			t.Errorf("Range=%q", got)
		}
		if r.URL.Path != "/bucket/prefix/p/"+root.PackID([]string{root.Hash(payload)}) {
			t.Error(r.URL.Path)
		}
		w.Header().Set("Content-Range", "bytes 262144-524287/524288")
		w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
		w.WriteHeader(206)
		w.Write(payload)
	}))
	defer server.Close()
	s := &S3{Bucket: "bucket", Prefix: "prefix", Client: s3.NewFromConfig(aws.Config{Region: "us-west-2", Credentials: credentials.NewStaticCredentialsProvider("test", "test", "")}, func(o *s3.Options) { o.BaseEndpoint = aws.String(server.URL); o.UsePathStyle = true })}
	b, e := Range(context.Background(), WithDepth(s, 64), "p/"+root.PackID([]string{root.Hash(payload)}), root.ChunkSize, root.ChunkSize)
	if e != nil || !bytes.Equal(b, payload) {
		t.Fatal(e)
	}
}

func TestPackUploadByteAccounting(t *testing.T) {
	ctx := context.Background()
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	s := &Uploaded{Store: Local{Dir: t.TempDir()}, DB: db.DB}
	b := make([]byte, root.ChunkSize)
	b[0] = 1
	h := root.Hash(b)
	id := root.PackID([]string{h})
	for i := 0; i < 2; i++ {
		sent, e := PutPack(ctx, s, id, b)
		if e != nil || sent != (i == 0) {
			t.Fatal(i, sent, e)
		}
	}
	l, ok, e := s.Location(ctx, h)
	if e != nil || !ok || l.Pack != id || l.Index != 0 {
		t.Fatal(l, ok, e)
	}
}
