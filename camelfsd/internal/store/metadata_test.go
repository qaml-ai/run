package store

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

// Exercise the SDK's actual metadata headers without using an AWS resource.
func TestS3PrefixedBlobMetadata(t *testing.T) {
	raw := []byte("hello")
	key := "tenant:repo/" + BlobKey(raw)
	sha := root.Hash(raw)
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bucket/prefix/"+key {
			t.Errorf("path=%q", r.URL.Path)
			w.WriteHeader(400)
			return
		}
		switch r.Method {
		case "PUT":
			writes++
			if got := r.Header.Get("X-Amz-Meta-X-Camel-Sha256"); got != sha {
				t.Errorf("sha256 metadata=%q", got)
			}
			body, e := io.ReadAll(r.Body)
			if e != nil || string(body) != string(raw) {
				t.Errorf("body=%q error=%v", body, e)
			}
		case "HEAD":
			w.Header().Set("Content-Length", fmt.Sprint(len(raw)))
			w.Header().Set("X-Amz-Meta-X-Camel-Sha256", sha)
		default:
			t.Errorf("method=%s", r.Method)
			w.WriteHeader(405)
		}
	}))
	defer server.Close()
	client := s3.NewFromConfig(aws.Config{Region: "us-east-1", Credentials: aws.AnonymousCredentials{}}, func(o *s3.Options) { o.BaseEndpoint = &server.URL; o.UsePathStyle = true })
	st := &S3{Client: client, Bucket: "bucket", Prefix: "prefix"}
	ctx := context.Background()
	if e := st.Put(ctx, key, raw); e != nil {
		t.Fatal(e)
	}
	file, e := os.CreateTemp(t.TempDir(), "blob")
	if e != nil {
		t.Fatal(e)
	}
	defer file.Close()
	if _, e = io.Copy(file, strings.NewReader(string(raw))); e != nil {
		t.Fatal(e)
	}
	if e = PutBlobFile(ctx, st, key, file, sha); e != nil {
		t.Fatal(e)
	}
	info, e := st.Head(ctx, key)
	if e != nil || info.Size != int64(len(raw)) || info.SHA256 != sha || writes != 2 {
		t.Fatal(info, writes, e)
	}
}
