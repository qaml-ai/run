package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

func workspaceFixture(t *testing.T, body string) (WorkspaceImage, *os.File) {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "image-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	if _, err := io.WriteString(f, body); err != nil {
		t.Fatal(err)
	}
	sha := root.Hash([]byte(body))
	return WorkspaceImage{Format: WorkspaceImageFormat, Lineage: "tenant:repo", Tree: strings.Repeat("a", 40), Blob: "w/" + sha, SHA256: sha, RawSHA256: strings.Repeat("b", 64), VirtualSize: 64 << 20, StoredSize: int64(len(body))}, f
}

func TestWorkspaceImagePublication(t *testing.T) {
	ctx := t.Context()
	raw := Local{t.TempDir()}
	s := ForLineage(WithDepth(raw, 2), "tenant:repo")
	d, file := workspaceFixture(t, "compressed canonical image")
	if _, found, err := GetWorkspaceImage(ctx, s, d.Lineage, d.Tree, d.VirtualSize); err != nil || found {
		t.Fatalf("absent = %v %v", found, err)
	}
	winner, err := PublishWorkspaceImage(ctx, s, d, file)
	if err != nil || winner != d {
		t.Fatalf("publish = %+v %v", winner, err)
	}
	got, found, err := GetWorkspaceImage(ctx, raw, d.Lineage, d.Tree, d.VirtualSize)
	if err != nil || !found || got != d {
		t.Fatalf("cross-host discover = %+v %v %v", got, found, err)
	}
	r, err := OpenReader(ctx, s, d.Blob)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(r)
	r.Close()
	if err != nil || root.Hash(b) != d.SHA256 {
		t.Fatalf("payload = %q %v", b, err)
	}
	b, err = ReadObjectRange(ctx, s, d.Blob, 2, 5, d.StoredSize)
	if err != nil || string(b) != "mpres" {
		t.Fatalf("payload range = %q %v", b, err)
	}
	if _, found, err := GetWorkspaceImage(ctx, s, d.Lineage, d.Tree, d.VirtualSize*2); err != nil || found {
		t.Fatalf("wrong shape = %v %v", found, err)
	}
	if _, _, err := GetWorkspaceImage(ctx, s, "another", d.Tree, d.VirtualSize); err == nil {
		t.Fatal("escaped lineage scope")
	}
	key, _ := WorkspaceImageKey(d.Lineage, d.Tree, d.VirtualSize)
	if err := os.Remove(filepath.Join(raw.Dir, d.Lineage, d.Blob)); err != nil {
		t.Fatal(err)
	}
	if _, found, err := GetWorkspaceImage(ctx, s, d.Lineage, d.Tree, d.VirtualSize); err != nil || !found {
		t.Fatalf("missing payload became a cache miss: %v %v", found, err)
	}
	if _, err := OpenReader(ctx, s, d.Blob); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing payload = %v", err)
	}
	if err := os.WriteFile(filepath.Join(raw.Dir, d.Lineage, key), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := GetWorkspaceImage(ctx, s, d.Lineage, d.Tree, d.VirtualSize); err == nil {
		t.Fatal("corrupt descriptor became a miss")
	}
}

func TestWorkspaceImageInvalidPublication(t *testing.T) {
	for _, fault := range []string{"digest", "size", "shape", "namespace", "format", "raw-digest"} {
		t.Run(fault, func(t *testing.T) {
			d, f := workspaceFixture(t, "payload")
			s := Local{t.TempDir()}
			switch fault {
			case "digest":
				d.SHA256 = strings.Repeat("c", 64)
				d.Blob = "w/" + d.SHA256
			case "size":
				d.StoredSize++
			case "shape":
				d.VirtualSize = 0
			case "namespace":
				d.Blob = "o/" + d.SHA256
			case "format":
				d.Format++
			case "raw-digest":
				d.RawSHA256 = "bad"
			}
			if _, err := PublishWorkspaceImage(t.Context(), s, d, f); err == nil {
				t.Fatal("invalid image published")
			}
			entries, err := os.ReadDir(s.Dir)
			if err != nil || len(entries) != 0 {
				t.Fatalf("failed validation wrote storage: %v %v", entries, err)
			}
		})
	}
}

func TestWorkspaceImageConcurrentPublishers(t *testing.T) {
	s := Local{t.TempDir()}
	const n = 12
	var wg sync.WaitGroup
	winners := make(chan WorkspaceImage, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		d, f := workspaceFixture(t, fmt.Sprintf("valid independent ext4 build %d", i))
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			winner, err := PublishWorkspaceImage(t.Context(), s, d, f)
			if err != nil {
				t.Error(err)
				return
			}
			winners <- winner
		}()
	}
	close(start)
	wg.Wait()
	close(winners)
	var winner WorkspaceImage
	for d := range winners {
		if winner.Tree == "" {
			winner = d
		}
		if d != winner {
			t.Fatalf("concurrent publishers disagreed: %+v %+v", d, winner)
		}
	}
	if winner.Tree == "" {
		t.Fatal("no successful publisher")
	}
	b, err := s.Get(t.Context(), winner.Lineage+"/"+winner.Blob)
	if err != nil || root.Hash(b) != winner.SHA256 {
		t.Fatalf("winner points at unavailable bytes: %v", err)
	}
}

func workspaceS3(t *testing.T, handler http.HandlerFunc) *S3 {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := s3.NewFromConfig(aws.Config{Region: "us-east-1", Credentials: aws.AnonymousCredentials{}, RetryMaxAttempts: 1}, func(o *s3.Options) {
		o.BaseEndpoint, o.UsePathStyle = &server.URL, true
	})
	return &S3{Client: client, Bucket: "bucket", Prefix: "prefix"}
}

func TestWorkspaceImageS3MissingAndFailure(t *testing.T) {
	d, _ := workspaceFixture(t, "payload")
	for _, code := range []int{404, 403, 503} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			s := workspaceS3(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
				name := "InternalError"
				if code == 404 {
					name = "NoSuchKey"
				}
				if code == 403 {
					name = "AccessDenied"
				}
				fmt.Fprintf(w, "<Error><Code>%s</Code></Error>", name)
			})
			_, found, err := GetWorkspaceImage(t.Context(), s, d.Lineage, d.Tree, d.VirtualSize)
			if found || (code == 404) != (err == nil) {
				t.Fatalf("status %d became found=%v err=%v", code, found, err)
			}
		})
	}
}

func TestWorkspaceImageS3PublicationOrdering(t *testing.T) {
	ctx := t.Context()
	d, f := workspaceFixture(t, "payload")
	key, _ := WorkspaceImageKey(d.Lineage, d.Tree, d.VirtualSize)
	for _, failPayload := range []bool{false, true} {
		t.Run(fmt.Sprint(failPayload), func(t *testing.T) {
			objects := make(map[string][]byte)
			var puts []string
			s := workspaceS3(t, func(w http.ResponseWriter, r *http.Request) {
				k := strings.TrimPrefix(r.URL.Path, "/bucket/prefix/")
				if r.Method == "GET" {
					body, ok := objects[k]
					if !ok {
						w.WriteHeader(404)
						io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
						return
					}
					w.Write(body)
					return
				}
				if r.Method != "PUT" || r.Header.Get("If-None-Match") != "*" {
					t.Errorf("nonconditional upload: %s %v", r.Method, r.Header)
					w.WriteHeader(400)
					return
				}
				puts = append(puts, k)
				if failPayload && strings.Contains(k, "/w/") {
					w.WriteHeader(403)
					io.WriteString(w, "<Error><Code>AccessDenied</Code></Error>")
					return
				}
				if _, exists := objects[k]; exists {
					w.WriteHeader(412)
					io.WriteString(w, "<Error><Code>PreconditionFailed</Code></Error>")
					return
				}
				objects[k], _ = io.ReadAll(r.Body)
			})
			winner, err := PublishWorkspaceImage(ctx, WithDepth(s, 1), d, f)
			if failPayload {
				if err == nil || len(puts) != 1 {
					t.Fatalf("failed bytes published descriptor: %v %v", puts, err)
				}
			} else {
				if err != nil || winner != d {
					t.Fatalf("publish = %+v %v", winner, err)
				}
				if len(puts) != 2 || puts[0] != d.Lineage+"/"+d.Blob || puts[1] != d.Lineage+"/"+key {
					t.Fatalf("publication order: %v", puts)
				}
			}
		})
	}
}

func TestWorkspaceImageDescriptorIdentity(t *testing.T) {
	d, _ := workspaceFixture(t, "payload")
	key, _ := WorkspaceImageKey(d.Lineage, d.Tree, d.VirtualSize)
	raw, _ := json.Marshal(d)
	if err := verify(d.Lineage+"/"+key, raw); err != nil {
		t.Fatal(err)
	}
	if err := verify("other/"+key, raw); err == nil {
		t.Fatal("accepted foreign lineage")
	}
	if _, err := decodeWorkspaceImage(append(bytes.Clone(raw), []byte(" {}")...)); err == nil {
		t.Fatal("accepted trailing JSON")
	}
	if _, err := decodeWorkspaceImage(bytes.Repeat([]byte(" "), workspaceDescriptorLimit+1)); err == nil {
		t.Fatal("accepted oversized descriptor")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, _, err := GetWorkspaceImage(ctx, Local{t.TempDir()}, d.Lineage, d.Tree, d.VirtualSize); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation = %v", err)
	}
}

func TestWorkspaceImageMultipartPublication(t *testing.T) {
	for _, fault := range []string{"", "part", "complete", "abort"} {
		t.Run(fault, func(t *testing.T) {
			d, f := workspaceFixture(t, "multipart bytes")
			var calls []string
			s := workspaceS3(t, func(w http.ResponseWriter, r *http.Request) {
				q := r.URL.Query()
				switch {
				case r.Method == "POST" && q.Has("uploads"):
					calls = append(calls, "create")
					if r.Header.Get("X-Amz-Meta-X-Camel-Sha256") != d.SHA256 {
						t.Error("missing payload digest metadata")
					}
					io.WriteString(w, "<InitiateMultipartUploadResult><UploadId>owned-upload</UploadId></InitiateMultipartUploadResult>")
				case r.Method == "PUT" && q.Get("uploadId") == "owned-upload":
					calls = append(calls, "part")
					if fault == "part" {
						w.WriteHeader(403)
						io.WriteString(w, "<Error><Code>AccessDenied</Code></Error>")
						return
					}
					body, _ := io.ReadAll(r.Body)
					if string(body) != "multipart bytes" {
						t.Errorf("part bytes = %q", body)
					}
					w.Header().Set("ETag", `"part-etag"`)
				case r.Method == "POST" && q.Get("uploadId") == "owned-upload":
					calls = append(calls, "complete")
					if r.Header.Get("If-None-Match") != "*" {
						t.Error("multipart completion was not conditional")
					}
					if fault == "complete" || fault == "abort" {
						w.WriteHeader(412)
						io.WriteString(w, "<Error><Code>PreconditionFailed</Code></Error>")
						return
					}
					io.WriteString(w, `<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>`)
				case r.Method == "DELETE" && q.Get("uploadId") == "owned-upload":
					calls = append(calls, "abort")
					if fault == "abort" {
						w.WriteHeader(403)
						io.WriteString(w, "<Error><Code>AccessDenied</Code></Error>")
						return
					}
					w.WriteHeader(204)
				default:
					t.Errorf("unexpected multipart request %s %s", r.Method, r.URL)
					w.WriteHeader(400)
				}
			})
			err := s.multipartWorkspaceFile(t.Context(), "prefix/"+d.Lineage+"/"+d.Blob, f, d.StoredSize, d.SHA256)
			expected := "create,part,complete"
			if fault == "part" {
				expected = "create,part,abort"
			}
			if fault == "complete" || fault == "abort" {
				expected += ",abort"
			}
			if strings.Join(calls, ",") != expected || (err != nil) != (fault != "") {
				t.Fatalf("multipart = %v %v", calls, err)
			}
			if fault == "complete" {
				if exists, _ := conditionalConflict(err); !exists {
					t.Fatalf("lost concurrent winner status: %v", err)
				}
			}
			if fault == "abort" {
				if exists, retry := conditionalConflict(err); exists || retry {
					t.Fatalf("ignored multipart cleanup failure: %v", err)
				}
			}
		})
	}
}
