package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type objectRangeErrorDB struct{ BundleDB }

func (objectRangeErrorDB) GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	return nil, errors.New("catalog unavailable")
}

func TestObjectRangePackedMember(t *testing.T) {
	ctx := t.Context()
	raw := Local{Dir: t.TempDir()}
	db := &bundleTestDB{rows: make(map[string]locatorItem)}
	s := ForLineage(WithDepth(WithBundles(raw, db, "objects"), 2), "range")
	blob := newSmall([]byte("before|wanted|after"))
	if _, err := PutSmallBlobs(ctx, s, []SmallBlob{blob}); err != nil {
		t.Fatal(err)
	}
	if exists, err := raw.Has(ctx, "range/"+blob.Key); err != nil || exists {
		t.Fatalf("packed fixture has a loose object: %v %v", exists, err)
	}
	got, err := ReadObjectRange(ctx, s, blob.Key, 7, 6, int64(len(blob.Data)))
	if err != nil || !bytes.Equal(got, blob.Data[7:13]) {
		t.Fatalf("packed range = %q, %v", got, err)
	}
	if _, err := ReadObjectRange(ctx, s, blob.Key, 7, 6, int64(len(blob.Data)+1)); err == nil {
		t.Fatal("accepted a mismatched logical object size")
	}
	failing := ForLineage(WithBundles(raw, objectRangeErrorDB{db}, "objects"), "range")
	if _, err := ReadObjectRange(ctx, failing, blob.Key, 7, 6, int64(len(blob.Data))); err == nil {
		t.Fatal("ignored a catalog error")
	}
	loc, err := LocateBundlesForRestore(ctx, s, []string{smallID(blob)})
	if err != nil {
		t.Fatal(err)
	}
	if err := raw.Put(ctx, "range/"+blob.Key, blob.Data); err != nil {
		t.Fatal(err)
	}
	delete(db.rows, "range/"+blob.Key)
	if _, err := ReadObjectRange(ctx, s, blob.Key, 7, 6, int64(len(blob.Data))); err == nil {
		t.Fatal("missing locator silently used loose bytes")
	}
	db.rows["range/"+blob.Key] = locationItem("range", smallID(blob), blobLocation{BundleRef: loc[smallID(blob)], attempt: "test"})
	if err := os.WriteFile(filepath.Join(raw.Dir, "range", loc[smallID(blob)].Key), []byte("corrupt pack"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadObjectRange(ctx, s, blob.Key, 7, 6, int64(len(blob.Data))); err == nil {
		t.Fatal("corrupt pack silently used loose bytes")
	}
}

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
