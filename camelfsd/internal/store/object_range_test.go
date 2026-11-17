package store

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestObjectRangeForPackedApplyPrototype(t *testing.T) {
	payload := []byte("before|wanted|after")
	key := "o/" + GitHash("blob", payload)
	for _, fault := range []string{"", "total", "short"} {
		t.Run(fault, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/bucket/prefix/tenant:repo/"+key || r.Header.Get("Range") != "bytes=7-12" {
					t.Errorf("unexpected range request: %s %s", r.URL.Path, r.Header.Get("Range"))
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				total := len(payload)
				if fault == "total" {
					total++
				}
				w.Header().Set("Content-Range", fmt.Sprintf("bytes 7-12/%d", total))
				w.Header().Set("Content-Length", "6")
				w.WriteHeader(http.StatusPartialContent)
				body := payload[7:13]
				if fault == "short" {
					body = body[:5]
				}
				_, _ = w.Write(body)
			}))
			defer server.Close()
			client := s3.NewFromConfig(aws.Config{Region: "us-east-1", Credentials: aws.AnonymousCredentials{}}, func(o *s3.Options) {
				o.BaseEndpoint, o.UsePathStyle = &server.URL, true
			})
			remote := ForLineage(WithDepth(&S3{Client: client, Bucket: "bucket", Prefix: "prefix"}, 2), "tenant:repo")
			got, err := ReadObjectRange(t.Context(), remote, key, 7, 6, int64(len(payload)))
			if fault == "" {
				if err != nil || !bytes.Equal(got, payload[7:13]) {
					t.Fatalf("range = %q, %v", got, err)
				}
			} else if err == nil {
				t.Fatalf("accepted %s response", fault)
			}
			if _, err := ReadObjectRange(t.Context(), remote, key, 15, 6, int64(len(payload))); err == nil {
				t.Fatal("accepted out-of-bounds range")
			}
		})
	}
}
