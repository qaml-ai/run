package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// Count actual GetObject HTTP attempts, including retries. Session requests and
// credential-provider calls and the untimed warm-up are excluded. The SDK's
// default retryer is unchanged.
type countingClient struct {
	client              *awshttp.BuildableClient
	active              atomic.Bool
	attempts, status503 atomic.Int64
}

func (c *countingClient) Do(r *http.Request) (*http.Response, error) {
	count := c.active.Load() && r.Method == http.MethodGet &&
		strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-") && !r.URL.Query().Has("session")
	if count {
		c.attempts.Add(1)
	}
	resp, err := c.client.Do(r)
	if count && resp != nil && resp.StatusCode == 503 {
		c.status503.Add(1)
	}
	return resp, err
}
func newClient(ctx context.Context, o options) (*s3.Client, *countingClient, error) {
	c := &countingClient{client: awshttp.NewBuildableClient().WithTransportOptions(func(t *http.Transport) {
		t.MaxIdleConns = max(100, o.concurrency)
		t.MaxIdleConnsPerHost = max(100, o.concurrency)
		t.MaxConnsPerHost = max(100, o.concurrency)
	})}
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(o.region), config.WithHTTPClient(c))
	if err != nil {
		return nil, nil, err
	}
	return s3.NewFromConfig(cfg), c, nil
}

type measurement struct {
	latency, ttfb time.Duration
	bytes         int64
}

func get(ctx context.Context, c *s3.Client, bucket string, r request, buf []byte) (measurement, error) {
	input := &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(r.key)}
	if r.byteRange != "" {
		input.Range = aws.String(r.byteRange)
	}
	start := time.Now()
	resp, err := c.GetObject(ctx, input)
	if err != nil {
		return measurement{}, err
	}
	defer resp.Body.Close()
	// Read one byte to measure the arrival of payload rather than headers.
	n, err := io.ReadFull(resp.Body, buf[:1])
	ttfb := time.Since(start)
	if err != nil {
		return measurement{}, fmt.Errorf("first byte: %w", err)
	}
	rest, err := io.ReadFull(resp.Body, buf[1:r.size])
	n += rest
	if err != nil {
		return measurement{}, fmt.Errorf("body: %w", err)
	}
	// Ensure EOF as well as the expected length, and fully consume the body.
	var extra [1]byte
	more, err := io.ReadFull(resp.Body, extra[:])
	elapsed := time.Since(start)
	if more != 0 || !errors.Is(err, io.EOF) {
		return measurement{}, fmt.Errorf("unexpected body length for %s", r.key)
	}
	return measurement{elapsed, ttfb, int64(n)}, nil
}
func verify(buf, scratch []byte, r request, size int, seed int64) error {
	for i := 0; i < r.count; i++ {
		fillChunk(scratch, seed, r.first+i)
		if !bytes.Equal(buf[i*size:(i+1)*size], scratch) {
			return fmt.Errorf("data mismatch: %s chunk %d", r.key, r.first+i)
		}
	}
	return nil
}

// Exactly workers goroutines consume an unbuffered queue. Cancel on the first
// error and wait for all in-flight operations before returning it.
func pool(ctx context.Context, workers int, requests []request, work func(context.Context, int, request) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	queue := make(chan request)
	var wg sync.WaitGroup
	var once sync.Once
	var failure error
	for id := 0; id < workers; id++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for r := range queue {
				if ctx.Err() != nil {
					return
				}
				if err := work(ctx, id, r); err != nil {
					once.Do(func() { failure = err; cancel() })
					return
				}
			}
		}(id)
	}
dispatch:
	for _, r := range requests {
		select {
		case queue <- r:
		case <-ctx.Done():
			break dispatch
		}
	}
	close(queue)
	wg.Wait()
	if failure != nil {
		return failure
	}
	return ctx.Err()
}
func cpu() (syscall.Rusage, error) {
	var r syscall.Rusage
	err := syscall.Getrusage(syscall.RUSAGE_SELF, &r)
	return r, err
}
func cpuSeconds(t syscall.Timeval) float64 { return float64(t.Sec) + float64(t.Usec)/1e6 }
func number(v float64) string              { return strconv.FormatFloat(v, 'f', 1, 64) }
func emit(header, row []string, include bool) error {
	w := csv.NewWriter(os.Stdout)
	if include {
		if err := w.Write(header); err != nil {
			return err
		}
	}
	if err := w.Write(row); err != nil {
		return err
	}
	w.Flush()
	return w.Error()
}
func fetch(ctx context.Context, o options) error {
	size := o.chunkKiB * 1024
	needed := neededChunks(o.chunks, o.subset, o.subsetSeed)
	requests, err := plan(o.prefix, o.mode, o.chunks, size, needed)
	if err != nil {
		return err
	}
	f, err := os.Create(o.out)
	if err != nil {
		return err
	}
	defer f.Close()
	if !o.keep {
		defer os.Remove(o.out)
	}
	if err = f.Truncate(int64(o.chunks) * int64(size)); err != nil {
		return err
	}
	client, counter, err := newClient(ctx, o)
	if err != nil {
		return err
	}
	if !o.cold {
		if _, err = client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(o.bucket), Key: aws.String(requests[0].key)}); err != nil {
			return fmt.Errorf("warm-up: %w", err)
		}
	}
	maxSize := 0
	for _, r := range requests {
		maxSize = max(maxSize, r.size)
	}
	buffers := make([][]byte, o.concurrency)
	scratch := make([][]byte, o.concurrency)
	for i := range buffers {
		buffers[i] = make([]byte, maxSize)
		scratch[i] = make([]byte, size)
	}
	results := make([]measurement, len(requests))
	var next atomic.Int64
	before, err := cpu()
	if err != nil {
		return err
	}
	start := time.Now()
	counter.active.Store(true)
	err = pool(ctx, o.concurrency, requests, func(ctx context.Context, id int, r request) error {
		m, err := get(ctx, client, o.bucket, r, buffers[id])
		if err != nil {
			return fmt.Errorf("GET %s: %w", r.key, err)
		}
		if err = verify(buffers[id], scratch[id], r, size, o.seed); err != nil {
			return err
		}
		n, err := f.WriteAt(buffers[id][:r.size], int64(r.first)*int64(size))
		if err != nil {
			return err
		}
		if n != r.size {
			return io.ErrShortWrite
		}
		results[int(next.Add(1)-1)] = m
		return nil
	})
	if err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	elapsed := time.Since(start)
	counter.active.Store(false)
	after, err := cpu()
	if err != nil {
		return err
	}
	lats := make([]time.Duration, len(results))
	ttfbs := make([]time.Duration, len(results))
	sizes := make([]int64, len(results))
	var total int64
	for i, m := range results {
		lats[i] = m.latency
		ttfbs[i] = m.ttfb
		sizes[i] = m.bytes
		total += m.bytes
	}
	cost := estimateCost(strings.HasSuffix(o.bucket, "--x-s3"), counter.attempts.Load(), sizes, o.prices)
	row := []string{o.label, o.store, o.mode, strconv.Itoa(o.chunks), strconv.Itoa(len(needed)), strconv.Itoa(o.concurrency), strconv.Itoa(len(requests)), strconv.FormatInt(counter.attempts.Load(), 10), strconv.FormatInt(counter.status503.Load(), 10), strconv.FormatInt(total, 10), number(float64(elapsed) / float64(time.Millisecond)), number(float64(total) / 1e6 / elapsed.Seconds()), number(percentile(lats, .5)), number(percentile(lats, .9)), number(percentile(lats, .99)), number(percentile(lats, 1)), number(percentile(ttfbs, .5)), number(percentile(ttfbs, .99)), strconv.FormatFloat(cpuSeconds(after.Utime)-cpuSeconds(before.Utime), 'f', 6, 64), strconv.FormatFloat(cpuSeconds(after.Stime)-cpuSeconds(before.Stime), 'f', 6, 64), strconv.FormatFloat(cost, 'g', 6, 64)}
	return emit(strings.Split("label,store,mode,chunks_total,chunks_needed,concurrency,requests,attempts,status503,bytes,total_ms,mb_per_s,lat_p50_ms,lat_p90_ms,lat_p99_ms,lat_max_ms,ttfb_p50_ms,ttfb_p99_ms,cpu_user_s,cpu_sys_s,est_cost_usd", ","), row, o.header)
}
func upload(ctx context.Context, o options) error {
	layouts := strings.Split(o.layouts, ",")
	size := o.chunkKiB * 1024
	// Validate all layouts before making any requests.
	for _, layout := range layouts {
		if layout == "range4m" {
			return fmt.Errorf("range4m is a fetch mode")
		}
		if _, err := perPack(layout, size); err != nil {
			return err
		}
	}
	client, _, err := newClient(ctx, o)
	if err != nil {
		return err
	}
	for _, layout := range layouts {
		requests, _ := plan(o.prefix, layout, o.chunks, size, neededChunks(o.chunks, 1, o.seed))
		pp, _ := perPack(layout, size)
		buffers := make([][]byte, o.concurrency)
		for i := range buffers {
			buffers[i] = make([]byte, pp*size)
		}
		start := time.Now()
		err = pool(ctx, o.concurrency, requests, func(ctx context.Context, id int, r request) error {
			buf := buffers[id][:r.size]
			for i := 0; i < r.count; i++ {
				fillChunk(buf[i*size:(i+1)*size], o.seed, r.first+i)
			}
			_, err := client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(o.bucket), Key: aws.String(r.key), Body: bytes.NewReader(buf)})
			return err
		})
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "%s objects=%d bytes=%d seconds=%.3f\n", layout, len(requests), int64(o.chunks)*int64(size), time.Since(start).Seconds())
	}
	return nil
}
func latency(ctx context.Context, o options) error {
	client, _, err := newClient(ctx, o)
	if err != nil {
		return err
	}
	size := o.sizeKiB * 1024
	key := o.prefix + "/small/obj"
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(o.bucket), Key: aws.String(key)})
	if err != nil {
		var status interface{ HTTPStatusCode() int }
		if !errors.As(err, &status) || status.HTTPStatusCode() != 404 {
			return err
		}
	}
	if err != nil || aws.ToInt64(head.ContentLength) != int64(size) {
		buf := make([]byte, size)
		fillChunk(buf, 1, 0)
		if _, err = client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(o.bucket), Key: aws.String(key), Body: bytes.NewReader(buf)}); err != nil {
			return err
		}
	}
	// A separate transport ensures the first GET has no reused connection/session.
	client, _, err = newClient(ctx, o)
	if err != nil {
		return err
	}
	buf := make([]byte, size)
	r := request{key: key, size: size}
	first, err := get(ctx, client, o.bucket, r, buf)
	if err != nil {
		return err
	}
	lats := make([]time.Duration, o.n)
	ttfbs := make([]time.Duration, o.n)
	for i := 0; i < o.n; i++ {
		m, err := get(ctx, client, o.bucket, r, buf)
		if err != nil {
			return err
		}
		lats[i] = m.latency
		ttfbs[i] = m.ttfb
	}
	return emit(strings.Split("label,store,size_kib,n,first_ttfb_ms,first_lat_ms,ttfb_p50_ms,ttfb_p90_ms,ttfb_p99_ms,lat_p50_ms,lat_p99_ms", ","), []string{o.label, o.store, strconv.Itoa(o.sizeKiB), strconv.Itoa(o.n), number(float64(first.ttfb) / float64(time.Millisecond)), number(float64(first.latency) / float64(time.Millisecond)), number(percentile(ttfbs, .5)), number(percentile(ttfbs, .9)), number(percentile(ttfbs, .99)), number(percentile(lats, .5)), number(percentile(lats, .99))}, o.header)
}
func cleanup(ctx context.Context, o options) error {
	client, _, err := newClient(ctx, o)
	if err != nil {
		return err
	}
	pages := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{Bucket: aws.String(o.bucket), Prefix: aws.String(o.prefix + "/")})
	deleted := 0
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return err
		}
		ids := make([]types.ObjectIdentifier, 0, len(page.Contents))
		for _, object := range page.Contents {
			ids = append(ids, types.ObjectIdentifier{Key: object.Key})
		}
		for len(ids) > 0 {
			n := min(1000, len(ids))
			result, err := client.DeleteObjects(ctx, &s3.DeleteObjectsInput{Bucket: aws.String(o.bucket), Delete: &types.Delete{Objects: ids[:n]}})
			if err != nil {
				return err
			}
			if len(result.Errors) > 0 {
				return fmt.Errorf("delete failed: %s: %s", aws.ToString(result.Errors[0].Key), aws.ToString(result.Errors[0].Message))
			}
			deleted += n
			ids = ids[n:]
		}
	}
	fmt.Fprintf(os.Stderr, "deleted=%d\n", deleted)
	return nil
}
