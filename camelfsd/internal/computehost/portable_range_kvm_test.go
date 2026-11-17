//go:build linux && kvm

package computehost

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// The spool is never advertised. restorePortableImage checks its full digest
// and exact decoded size before exposing the cache file.
func downloadPortableRanges(ctx context.Context, client *s3.Client, bucket, key, dir string, size int64) (*os.File, int, error) {
	const chunk = int64(8 << 20)
	if size <= 0 {
		return nil, 0, fmt.Errorf("invalid portable object size")
	}
	spool, err := os.CreateTemp(dir, ".portable-range-*.gz")
	if err != nil {
		return nil, 0, err
	}
	var offsets []string
	for start := int64(0); start < size; start += chunk {
		offsets = append(offsets, fmt.Sprint(start))
	}
	err = store.Parallel(ctx, 32, offsets, func(offset string) error {
		var start int64
		if _, err := fmt.Sscan(offset, &start); err != nil {
			return err
		}
		length := min(chunk, size-start)
		end := start + length - 1
		response, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(key), Range: aws.String(fmt.Sprintf("bytes=%d-%d", start, end))})
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if aws.ToInt64(response.ContentLength) != length || aws.ToString(response.ContentRange) != fmt.Sprintf("bytes %d-%d/%d", start, end, size) {
			return fmt.Errorf("invalid portable object range response")
		}
		data := make([]byte, length)
		if _, err := io.ReadFull(response.Body, data); err != nil {
			return fmt.Errorf("truncated portable object range: %w", err)
		}
		var extra [1]byte
		if _, err := io.ReadFull(response.Body, extra[:]); err != io.EOF {
			return fmt.Errorf("portable object range has trailing bytes")
		}
		_, err = spool.WriteAt(data, start)
		return err
	})
	if err == nil {
		_, err = spool.Seek(0, io.SeekStart)
	}
	if err != nil {
		spool.Close()
		os.Remove(spool.Name())
		return nil, len(offsets), err
	}
	return spool, len(offsets), nil
}

func TestPortableImageRangeFetch(t *testing.T) {
	payload := bytes.Repeat([]byte("0123456789abcdef"), 1200000)
	for _, fault := range []string{"", "total", "short"} {
		t.Run(fault, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var start, end int64
				if r.URL.Path != "/bucket/lineage/clean/artifact.gz" {
					t.Errorf("wrong object path: %s", r.URL.Path)
					w.WriteHeader(400)
					return
				}
				if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &start, &end); err != nil || start < 0 || end >= int64(len(payload)) || end < start {
					t.Errorf("invalid range request: %s", r.Header.Get("Range"))
					w.WriteHeader(400)
					return
				}
				total := len(payload)
				if fault == "total" {
					total++
				}
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, total))
				w.Header().Set("Content-Length", fmt.Sprint(end-start+1))
				w.WriteHeader(http.StatusPartialContent)
				if fault == "short" {
					end--
				}
				_, _ = w.Write(payload[start : end+1])
			}))
			defer server.Close()
			client := s3.NewFromConfig(aws.Config{Region: "us-west-2", Credentials: aws.AnonymousCredentials{}}, func(o *s3.Options) {
				o.BaseEndpoint, o.UsePathStyle = &server.URL, true
			})
			dir := t.TempDir()
			f, ranges, err := downloadPortableRanges(t.Context(), client, "bucket", "lineage/clean/artifact.gz", dir, int64(len(payload)))
			if fault != "" {
				if err == nil {
					f.Close()
					t.Fatal("bad range accepted")
				}
				files, err := filepath.Glob(filepath.Join(dir, "*"))
				if err != nil || len(files) != 0 {
					t.Fatalf("range failure left spool: %v %v", files, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			defer os.Remove(f.Name())
			got, err := io.ReadAll(f)
			if err != nil || !bytes.Equal(got, payload) || ranges != 3 || calls.Load() != 3 {
				t.Fatalf("range assembly mismatch ranges=%d calls=%d error=%v", ranges, calls.Load(), err)
			}
		})
	}
}
