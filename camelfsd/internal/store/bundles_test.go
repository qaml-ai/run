package store

import (
	"bytes"
	"context"
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
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

type bundleTestDB struct {
	mu      sync.Mutex
	rows    map[string]locatorItem
	before  func(context.Context, locatorItem) error
	after   func(locatorItem) error
	retry   bool
	batches int
	query   func(context.Context, *dynamodb.QueryInput) (*dynamodb.QueryOutput, error)
}

func locatorTestKey(item locatorItem) string {
	return itemString(item, "lineage") + "/" + itemString(item, "id")
}

func (d *bundleTestDB) GetItem(_ context.Context, in *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !aws.ToBool(in.ConsistentRead) {
		return nil, fmt.Errorf("lookup must be consistent")
	}
	return &dynamodb.GetItemOutput{Item: d.rows[locatorTestKey(in.Key)]}, nil
}

func (d *bundleTestDB) BatchGetItem(_ context.Context, in *dynamodb.BatchGetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.batches++
	out := &dynamodb.BatchGetItemOutput{Responses: make(map[string][]locatorItem)}
	if d.retry {
		d.retry = false
		out.UnprocessedKeys = in.RequestItems
		return out, nil
	}
	for table, req := range in.RequestItems {
		if len(req.Keys) > 100 || !aws.ToBool(req.ConsistentRead) {
			return nil, fmt.Errorf("invalid locator batch")
		}
		for _, key := range req.Keys {
			if row := d.rows[locatorTestKey(key)]; row != nil {
				out.Responses[table] = append(out.Responses[table], row)
			}
		}
	}
	return out, nil
}

func (d *bundleTestDB) Query(ctx context.Context, in *dynamodb.QueryInput, _ ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	if d.query == nil {
		return nil, fmt.Errorf("unexpected locator query")
	}
	return d.query(ctx, in)
}

func (d *bundleTestDB) PutItem(ctx context.Context, in *dynamodb.PutItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	if d.before != nil {
		if err := d.before(ctx, in.Item); err != nil {
			return nil, err
		}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	key := locatorTestKey(in.Item)
	if d.rows[key] != nil {
		return nil, &types.ConditionalCheckFailedException{}
	}
	d.rows[key] = in.Item
	if d.after != nil {
		return &dynamodb.PutItemOutput{}, d.after(in.Item)
	}
	return &dynamodb.PutItemOutput{}, nil
}

func newSmall(b []byte) SmallBlob {
	return SmallBlob{Key: BlobKey(b), SHA256: root.Hash(b), Data: b}
}

func smallID(blob SmallBlob) string { return strings.TrimPrefix(blob.Key, "o/") }

func putTestBlob(t *testing.T, s Store, blob SmallBlob) error {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "blob")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(blob.Data); err != nil {
		t.Fatal(err)
	}
	_, err = PutBlobFileIfAbsent(t.Context(), s, blob.Key, f, blob.SHA256)
	return err
}

func TestBundleRoundTrip(t *testing.T) {
	db, table := ddbtest.Table(t, ddbtest.Schema{
		Keys: []types.KeySchemaElement{
			{AttributeName: aws.String("lineage"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("id"), KeyType: types.KeyTypeRange},
		},
		Attributes: []types.AttributeDefinition{
			{AttributeName: aws.String("lineage"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("id"), AttributeType: types.ScalarAttributeTypeS},
		},
	})
	checkBundleRoundTrip(t, db, table)
	b := &bundled{db: db, table: table}
	id := smallID(newSmall([]byte("one")))
	locations, err := b.queryLocations(t.Context(), "tenant:repo", map[string]struct{}{id: {}})
	if err != nil || len(locations) != 1 || locations[id].Key == "" {
		t.Fatalf("query locations = %v, %v", locations, err)
	}
}

func TestBundleRoundTripInMemory(t *testing.T) {
	checkBundleRoundTrip(t, &bundleTestDB{rows: make(map[string]locatorItem), retry: true}, "objects")
}

func checkBundleRoundTrip(t *testing.T, db BundleDB, table string) {
	ctx := t.Context()
	raw := Local{Dir: t.TempDir()}
	loose := ForLineage(raw, "tenant:repo")
	s := ForLineage(WithBundles(WithDepth(raw, 4), db, table), "tenant:repo")
	reader := ForLineage(WithBundles(raw, db, table), "tenant:repo")
	if BundlesEnabled(loose) || !BundlesEnabled(s) || Depth(s) != 4 {
		t.Fatal("bundle modes or fetch budget changed")
	}
	a, b, old, empty := newSmall([]byte("one")), newSmall([]byte("second file")), newSmall([]byte("loose")), newSmall(nil)
	if err := loose.Put(ctx, old.Key, old.Data); err != nil {
		t.Fatal(err)
	}
	results, err := PutSmallBlobs(ctx, s, []SmallBlob{a, old, b, a, empty})
	if err != nil || len(results) != 4 || !results[a.Key] || !results[b.Key] || !results[empty.Key] || results[old.Key] {
		t.Fatalf("publication = %v, %v", results, err)
	}
	ids := []string{smallID(a), smallID(b), smallID(old), smallID(empty), smallID(a)}
	refs, err := LocateBundles(ctx, reader, ids)
	one := refs[smallID(a)]
	if err != nil || len(refs) != 3 || refs[smallID(b)].Key != one.Key || refs[smallID(empty)].Key != one.Key {
		t.Fatalf("locations = %v, %v", refs, err)
	}
	data, err := ReadBundle(ctx, reader, one.Key, one.PackSize)
	if err != nil || int64(len(data)) != one.PackSize {
		t.Fatalf("bundle read length %d: %v", len(data), err)
	}
	for _, blob := range []SmallBlob{a, b, old, empty} {
		if info, err := reader.Head(ctx, blob.Key); err != nil || info != (Info{int64(len(blob.Data)), blob.SHA256}) {
			t.Fatalf("head %s = %+v, %v", blob.Key, info, err)
		}
		if has, err := reader.Has(ctx, blob.Key); err != nil || !has {
			t.Fatalf("has %s = %t, %v", blob.Key, has, err)
		}
		if got, err := reader.Get(ctx, blob.Key); err != nil || !bytes.Equal(got, blob.Data) {
			t.Fatalf("get %s = %q, %v", blob.Key, got, err)
		}
		r, err := OpenReader(ctx, reader, blob.Key)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(r)
		closeErr := r.Close()
		if err != nil || closeErr != nil || !bytes.Equal(got, blob.Data) {
			t.Fatalf("open %s = %q, %v, %v", blob.Key, got, err, closeErr)
		}
	}
	if err := putTestBlob(t, reader, a); err != nil {
		t.Fatal(err)
	}
	if has, err := loose.Has(ctx, a.Key); err != nil || has {
		t.Fatalf("duplicate standalone wrote loose %s: %t, %v", a.Key, has, err)
	}
	other := ForLineage(WithBundles(raw, db, table), "tenant:other")
	if has, err := other.Has(ctx, a.Key); err != nil || has {
		t.Fatalf("cross-lineage object visible: %t, %v", has, err)
	}
	if refs, err := LocateBundles(ctx, other, ids); err != nil || len(refs) != 0 {
		t.Fatalf("cross-lineage locators: %v, %v", refs, err)
	}
	if _, err := ReadBundle(ctx, other, one.Key, one.PackSize); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cross-lineage bundle access: %v", err)
	}
	bad := append([]byte(nil), data...)
	bad[one.Offset] ^= 1
	if err := os.WriteFile(filepath.Join(raw.Dir, "tenant:repo", one.Key), bad, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Get(ctx, a.Key); err == nil {
		t.Fatal("accepted corrupt member")
	}
	if _, err := ReadBundle(ctx, reader, one.Key, one.PackSize); err == nil {
		t.Fatal("accepted corrupt bundle")
	}
	if _, err := ReadBundle(ctx, reader, one.Key, one.PackSize-1); err == nil {
		t.Fatal("accepted an overlong body")
	}
}

func TestBundlePublicationReportsPartialAndUncertainResults(t *testing.T) {
	raw := Local{Dir: t.TempDir()}
	good, bad := newSmall([]byte("good")), newSmall([]byte("bad"))
	failure := errors.New("catalog temporarily unavailable")
	db := &bundleTestDB{rows: make(map[string]locatorItem)}
	db.before = func(ctx context.Context, item locatorItem) error {
		physical := "tenant:repo/" + itemString(item, "pack")
		if has, err := raw.Has(ctx, physical); err != nil || !has {
			return fmt.Errorf("pack wasn't durable before its locator: %v", err)
		}
		if itemString(item, "id") == bad.Key {
			return failure
		}
		return nil
	}
	db.after = func(locatorItem) error { return errors.New("response lost after commit") }
	s := ForLineage(WithBundles(raw, db, "objects"), "tenant:repo")
	results, err := PutSmallBlobs(t.Context(), s, []SmallBlob{good, bad})
	if !errors.Is(err, failure) || len(results) != 1 || !results[good.Key] {
		t.Fatalf("results = %v, %v", results, err)
	}
	if has, err := s.Has(t.Context(), bad.Key); has || err != nil {
		t.Fatalf("unpublished member visible: %t, %v", has, err)
	}
}

func TestS3BundlePointReadUsesRange(t *testing.T) {
	blob := newSmall([]byte("wanted"))
	payload := []byte("before|wanted|after")
	ref := BundleRef{
		Key: "p/" + root.Hash(payload), SHA256: blob.SHA256,
		Offset: 7, Size: int64(len(blob.Data)), PackSize: int64(len(payload)),
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/bucket/prefix/tenant:repo/"+ref.Key || r.Header.Get("Range") != "bytes=7-12" {
			t.Errorf("unexpected point read %s %s %q", r.Method, r.URL.Path, r.Header.Get("Range"))
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Range", "bytes 7-12/19")
		w.Header().Set("Content-Length", "6")
		w.WriteHeader(http.StatusPartialContent)
		w.Write(blob.Data)
	}))
	defer server.Close()
	client := s3.NewFromConfig(aws.Config{Region: "us-east-1", Credentials: aws.AnonymousCredentials{}}, func(o *s3.Options) {
		o.BaseEndpoint, o.UsePathStyle = &server.URL, true
	})
	remote := ForLineage(WithDepth(&S3{Client: client, Bucket: "bucket", Prefix: "prefix"}, 1), "tenant:repo")
	got, err := ReadBundleMember(t.Context(), remote, smallID(blob), ref)
	if err != nil || !bytes.Equal(got, blob.Data) {
		t.Fatalf("GET range = %q, %v", got, err)
	}
	ref.PackSize++
	if _, err := ReadBundleMember(t.Context(), remote, smallID(blob), ref); err == nil {
		t.Fatal("accepted inconsistent physical pack size")
	}
}

func TestBundleAndSingletonHaveOneCreator(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	raw := Local{Dir: t.TempDir()}
	arrived := make(chan struct{}, 2)
	release := make(chan struct{})
	db := &bundleTestDB{rows: make(map[string]locatorItem)}
	blob := newSmall([]byte("one durable creator"))
	db.before = func(ctx context.Context, item locatorItem) error {
		if itemString(item, "id") != blob.Key {
			return nil
		}
		arrived <- struct{}{}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	writer := ForLineage(WithBundles(raw, db, "objects"), "tenant:repo")
	single := ForLineage(WithBundles(raw, db, "objects"), "tenant:repo")
	type outcome struct {
		created bool
		err     error
	}
	packed, singleton := make(chan outcome, 1), make(chan outcome, 1)
	go func() {
		results, err := PutSmallBlobs(ctx, writer, []SmallBlob{blob, newSmall([]byte("another bundle member"))})
		packed <- outcome{results[blob.Key], err}
	}()
	select {
	case <-arrived: // Pack exists and a packed location is about to publish.
	case out := <-packed:
		t.Fatalf("packing stopped before its locator: %+v", out)
	}
	f, err := os.CreateTemp(t.TempDir(), "file")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(blob.Data); err != nil {
		t.Fatal(err)
	}
	go func() {
		created, err := PutBlobFileIfAbsent(ctx, single, blob.Key, f, blob.SHA256)
		singleton <- outcome{created, err}
	}()
	select {
	case <-arrived: // Both bundles exist and both writers are attempting publication.
	case out := <-singleton:
		t.Fatalf("put stopped before its locator: %+v", out)
	}
	close(release)
	x, y := <-packed, <-singleton
	if x.err != nil || y.err != nil || x.created == y.created {
		t.Fatalf("expected one creator: pack %+v, singleton %+v", x, y)
	}
	if got, err := single.Get(ctx, blob.Key); err != nil || !bytes.Equal(got, blob.Data) {
		t.Fatalf("read winner = %q, %v", got, err)
	}
}

func TestFailedSingletonPublicationCanCreateOnRetry(t *testing.T) {
	for _, mode := range []string{"standalone", "batch"} {
		t.Run(mode, func(t *testing.T) {
			ctx := t.Context()
			raw := Local{Dir: t.TempDir()}
			lineage := "tenant:repo"
			blob := newSmall([]byte("retry this blob"))
			failure := errors.New("catalog temporarily unavailable")
			db := &bundleTestDB{rows: make(map[string]locatorItem), before: func(context.Context, locatorItem) error { return failure }}
			s := ForLineage(WithBundles(raw, db, "objects"), lineage)
			f, err := os.CreateTemp(t.TempDir(), "blob")
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if _, err := f.Write(blob.Data); err != nil {
				t.Fatal(err)
			}
			put := func() (bool, error) {
				return PutBlobFileIfAbsent(ctx, s, blob.Key, f, blob.SHA256)
			}
			if wrote, err := put(); wrote || !errors.Is(err, failure) {
				t.Fatalf("initial creation = %t, %v", wrote, err)
			}
			if has, err := raw.Has(ctx, lineage+"/p/"+blob.SHA256); !has || err != nil {
				t.Fatalf("staged bundle = %t, %v", has, err)
			}
			if has, err := s.Has(ctx, blob.Key); has || err != nil {
				t.Fatalf("unpublished singleton visible = %t, %v", has, err)
			}
			db.before = nil
			retry := put
			if mode == "batch" {
				retry = func() (bool, error) {
					results, err := PutSmallBlobs(ctx, s, []SmallBlob{blob, newSmall([]byte("other member"))})
					return results[blob.Key], err
				}
			}
			if wrote, err := retry(); !wrote || err != nil {
				t.Fatalf("retry creation = %t, %v", wrote, err)
			}
			if wrote, err := put(); wrote || err != nil {
				t.Fatalf("duplicate creation = %t, %v", wrote, err)
			}
		})
	}
}
