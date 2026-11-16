package objects

import (
	"bytes"
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type publicationPuts struct {
	store.Store
	count atomic.Int32
}

func publicationCatalog(t *testing.T) (*dynamodb.Client, string) {
	t.Helper()
	return ddbtest.Table(t, ddbtest.Schema{
		Keys: []types.KeySchemaElement{
			{AttributeName: aws.String("lineage"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("id"), KeyType: types.KeyTypeRange},
		},
		Attributes: []types.AttributeDefinition{
			{AttributeName: aws.String("lineage"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("id"), AttributeType: types.ScalarAttributeTypeS},
		},
	})
}

func TestPackedPublicationAccountsOnceAndRebuildsMembership(t *testing.T) {
	ctx := t.Context()
	client, table := publicationCatalog(t)
	remote := store.Local{Dir: t.TempDir()}
	r := repository(t)
	r.Store = remote
	loose := []byte("a preexisting loose blob")
	if _, err := r.Upload(ctx, "l", "", int64(len(loose)), bytes.NewReader(loose)); err != nil {
		t.Fatal(err)
	}
	r.Store = store.WithBundles(remote, client, table)
	r = r.ForLineage("l")
	packed := []byte("a new packed blob")
	large := bytes.Repeat([]byte("z"), store.BundleMaxBlob+1)
	contents := [][]byte{loose, packed, nil, large}
	ids := make([]string, len(contents))
	for i, raw := range contents {
		ids[i] = store.GitHash("blob", raw)
	}

	for _, retry := range []bool{false, true} {
		batch := r.BeginPublication()
		for _, raw := range contents {
			batch.StageBlob(raw)
		}
		batch.StageBlob(packed)
		callbacks := make(chan Blob, len(contents)+1)
		batch.OnBlobUpload(func(_ context.Context, blob Blob) error {
			callbacks <- blob
			return nil
		})
		if err := batch.Flush(ctx); err != nil {
			t.Fatal(err)
		}
		close(callbacks)
		var newlyWritten int64
		seen := make(map[string]bool, len(contents))
		for blob := range callbacks {
			if seen[blob.SHA1] {
				t.Fatalf("duplicate accounting callback for %s", blob.SHA1)
			}
			seen[blob.SHA1] = true
			if !blob.Existing {
				newlyWritten += blob.Size
			}
		}
		wantBytes := int64(len(packed) + len(large))
		if retry {
			wantBytes = 0
		}
		if len(seen) != len(contents) || newlyWritten != wantBytes {
			t.Fatalf("retry=%t: accounted %d distinct blobs and %d new bytes, want %d and %d", retry, len(seen), newlyWritten, len(contents), wantBytes)
		}
	}

	locations, err := store.LocateBundles(ctx, r.Store, ids)
	if err != nil || len(locations) != 2 || locations[ids[1]].Key == "" || locations[ids[1]].Key != locations[ids[2]].Key {
		t.Fatalf("packed locations = %+v, err = %v", locations, err)
	}
	if blob, err := r.Upload(ctx, "l", "", int64(len(packed)), bytes.NewReader(packed)); err != nil || !blob.Existing {
		t.Fatalf("standalone retry = %+v, err = %v", blob, err)
	}
	fresh := repository(t)
	fresh.Store = store.WithBundles(remote, client, table)
	infos, err := fresh.BlobInfos(ctx, "l", ids)
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string]File, len(contents))
	for i, raw := range contents {
		info := infos[ids[i]]
		sha256 := root.Hash(raw)
		if info.Err != nil || info.Blob.SHA256 != sha256 || info.Blob.Size != int64(len(raw)) {
			t.Fatalf("blob info for %s = %+v", ids[i], info)
		}
		files[ids[i]] = File{SHA256: sha256}
	}
	if tree, err := fresh.Import(ctx, Request{Lineage: "l", Files: files}); err != nil || tree.Blobs != len(contents) {
		t.Fatalf("fresh import = %+v, err = %v", tree, err)
	}
}

type failingBlobCatalog struct {
	*dynamodb.Client
	id  string
	err error
}

func (c failingBlobCatalog) PutItem(ctx context.Context, q *dynamodb.PutItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	if q.Item["id"].(*types.AttributeValueMemberS).Value == c.id {
		return nil, c.err
	}
	return c.Client.PutItem(ctx, q, opts...)
}

func TestFailedPackPublicationAccountsForDurableMembers(t *testing.T) {
	ctx := t.Context()
	client, table := publicationCatalog(t)
	remote := store.Local{Dir: t.TempDir()}
	good, bad := []byte("durable"), []byte("rejected")
	failure := errors.New("locator refused")
	r := repository(t)
	r.Store = store.WithBundles(remote, failingBlobCatalog{client, store.BlobKey(bad), failure}, table)
	r = r.ForLineage("l")
	batch := r.BeginPublication()
	goodBlob, badBlob := batch.StageBlob(good), batch.StageBlob(bad)
	tree, err := batch.StageSizedTree(ctx, []Entry{{Path: "file", SHA1: goodBlob.SHA1, Mode: "100644", Size: goodBlob.Size}})
	if err != nil {
		t.Fatal(err)
	}
	callbacks := make(chan Blob, 2)
	batch.OnBlobUpload(func(_ context.Context, blob Blob) error {
		callbacks <- blob
		return nil
	})
	if err := batch.Flush(ctx); !errors.Is(err, failure) {
		t.Fatalf("flush error = %v", err)
	}
	close(callbacks)
	blob, ok := <-callbacks
	if !ok || blob.SHA1 != goodBlob.SHA1 || blob.Existing || len(callbacks) != 0 {
		t.Fatalf("unexpected accounting for partial failure: %+v", blob)
	}
	for _, notCached := range []string{tree, badBlob.SHA1} {
		var count int
		if err := r.DB.DB.QueryRowContext(ctx, "SELECT count(*) FROM lineage_objects WHERE lineage='l' AND id=?", notCached).Scan(&count); err != nil || count != 0 {
			t.Fatalf("cached membership for %s: count=%d err=%v", notCached, count, err)
		}
	}
}

func (s *publicationPuts) Put(ctx context.Context, key string, b []byte) error {
	s.count.Add(1)
	return s.Store.Put(ctx, key, b)
}

func TestPublicationCacheRollsBackAndRetries(t *testing.T) {
	ctx := t.Context()
	r := repository(t)
	spy := &publicationPuts{Store: r.Store}
	// Host repositories already wrap their store with upload inventory.
	r.Store = &store.Uploaded{Store: store.WithDepth(spy, 64), DB: r.DB.DB}
	batch := r.ForLineage("l").BeginPublication()
	if _, err := batch.StageSizedTree(ctx, []Entry{}); err != nil {
		t.Fatal(err)
	}
	if _, err := batch.PutObject(ctx, "l", "commit", []byte("commit")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.DB.DB.Exec(`CREATE TRIGGER reject_upload BEFORE INSERT ON uploaded
BEGIN SELECT RAISE(ABORT, 'publication failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := batch.Flush(ctx); err == nil || err.Error() != "publication failure" {
		t.Fatalf("flush = %v", err)
	}
	assertRows := func(query string, want int) {
		t.Helper()
		var got int
		if err := r.DB.DB.QueryRow(query).Scan(&got); err != nil || got != want {
			t.Fatalf("%s: count=%d want=%d err=%v", query, got, want, err)
		}
	}
	assertRows("SELECT count(*) FROM objects", 0)
	assertRows("SELECT count(*) FROM tree_sizes", 0)
	assertRows("SELECT count(*) FROM lineage_objects", 0)
	assertRows("SELECT count(*) FROM uploaded", 0)
	if got := spy.count.Load(); got != 3 {
		t.Fatalf("durable PUTs=%d want=3", got)
	}
	if _, err := r.DB.DB.Exec("DROP TRIGGER reject_upload"); err != nil {
		t.Fatal(err)
	}
	if err := batch.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	assertRows("SELECT count(*) FROM objects", 2)
	assertRows("SELECT count(*) FROM tree_sizes", 1)
	assertRows("SELECT count(*) FROM lineage_objects", 2)
	assertRows("SELECT count(*) FROM uploaded", 3)
	if got := spy.count.Load(); got != 6 {
		t.Fatalf("durable PUTs including retry=%d want=6", got)
	}
}
