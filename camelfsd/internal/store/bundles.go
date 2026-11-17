package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"sync"

	"github.com/qaml-ai/run/camelfsd/internal/root"
)

const (
	BundleTargetBytes = 8 << 20
	bundleConcurrency = 32
)

type SmallBlob struct {
	Key, SHA256 string
	Data        []byte
}

type BundleRef struct {
	Key, SHA256            string
	Offset, Size, PackSize int64
}

func ValidateBundleRef(ref BundleRef) bool {
	digest, ok := strings.CutPrefix(ref.Key, "p/")
	return ok && root.Hex(digest, 64) && root.Hex(ref.SHA256, 64) &&
		ref.Size >= 0 && ref.Size <= BundleMaxBlob && ref.PackSize >= ref.Size &&
		ref.PackSize <= BundleTargetBytes && ref.Offset >= 0 && ref.Offset <= ref.PackSize-ref.Size
}

type bundled struct {
	Store
	db    BundleDB
	table string
}

// BundlesEnabled reports whether this store can publish new bundles.
func BundlesEnabled(s Store) bool {
	b, _ := bundleScope(s)
	return b != nil
}

func bundleScope(s Store) (*bundled, string) {
	switch v := s.(type) {
	case *bundled:
		return v, ""
	case *scoped:
		b, _ := bundleScope(v.Store)
		return b, v.lineage
	case *limited:
		return bundleScope(v.Store)
	case *Uploaded:
		return bundleScope(v.Store)
	default:
		return nil, ""
	}
}

func (s *bundled) blob(ctx context.Context, key string) (blobLocation, error) {
	lineage, kind, id, ok := splitKey(key)
	if !ok || kind != "o" || !root.Hex(id, 40) {
		return blobLocation{}, nil
	}
	return s.lookup(ctx, lineage, id)
}

func (s *bundled) Head(ctx context.Context, key string) (Info, error) {
	loc, err := s.blob(ctx, key)
	if err != nil {
		return Info{}, err
	}
	if loc.SHA256 != "" {
		return Info{Size: loc.Size, SHA256: loc.SHA256}, nil
	}
	return s.Store.Head(ctx, key)
}

func (s *bundled) Has(ctx context.Context, key string) (bool, error) {
	loc, err := s.blob(ctx, key)
	if err != nil {
		return false, err
	}
	if loc.SHA256 != "" {
		return true, nil
	}
	return s.Store.Has(ctx, key)
}

func (s *bundled) Get(ctx context.Context, key string) ([]byte, error) {
	loc, err := s.blob(ctx, key)
	if err != nil {
		return nil, err
	}
	if loc.Key == "" {
		return s.Store.Get(ctx, key)
	}
	return s.readMember(ctx, key, loc.BundleRef)
}

func (s *bundled) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	loc, err := s.blob(ctx, key)
	if err != nil {
		return nil, err
	}
	if loc.Key == "" {
		return OpenReader(ctx, s.Store, key)
	}
	b, err := s.readMember(ctx, key, loc.BundleRef)
	if err != nil {
		return nil, err
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}

func (s *bundled) readMember(ctx context.Context, key string, ref BundleRef) ([]byte, error) {
	lineage, _, id, _ := splitKey(key)
	return readBundleMember(ctx, s.Store, lineage, id, ref)
}

// ReadBundleMember verifies a member located by LocateBundles without another
// catalog lookup. Object stores read only the member's byte range.
func ReadBundleMember(ctx context.Context, s Store, id string, ref BundleRef) ([]byte, error) {
	_, lineage := bundleScope(s)
	if !Lineage(lineage) || !root.Hex(id, 40) || !ValidateBundleRef(ref) {
		return nil, fmt.Errorf("invalid bundle member")
	}
	return readBundleMember(ctx, s, lineage, id, ref)
}

func readBundleMember(ctx context.Context, s Store, lineage, id string, ref BundleRef) ([]byte, error) {
	var data []byte
	if ref.Size != 0 {
		var err error
		data, err = readBundleRange(ctx, s, lineage+"/"+ref.Key, ref)
		if err != nil {
			return nil, err
		}
	}
	if int64(len(data)) != ref.Size || root.Hash(data) != ref.SHA256 || GitHash("blob", data) != id {
		return nil, fmt.Errorf("bundle member %s failed verification", id)
	}
	return data, nil
}

// LocateBundles resolves packed members of an already published tree. Omitted
// IDs use the original loose store. IDs are bare Git blob hashes.
func LocateBundles(ctx context.Context, s Store, ids []string) (map[string]BundleRef, error) {
	return locateBundles(ctx, s, ids, false)
}

// LocateBundlesForRestore requires a locator for each requested small blob
// when a bundle catalog is configured. Stores without a catalog read loose
// blobs through the existing restore path.
func LocateBundlesForRestore(ctx context.Context, s Store, ids []string) (map[string]BundleRef, error) {
	return locateBundles(ctx, s, ids, true)
}

func locateBundles(ctx context.Context, s Store, ids []string, restore bool) (map[string]BundleRef, error) {
	b, lineage := bundleScope(s)
	if b == nil {
		return nil, nil
	}
	if !Lineage(lineage) {
		return nil, fmt.Errorf("bundle access requires a lineage")
	}
	lookup := b.lookupBatch
	if restore {
		lookup = b.lookupRestore
	}
	locs, err := lookup(ctx, lineage, ids)
	if err != nil {
		return nil, err
	}
	refs := make(map[string]BundleRef, len(locs))
	for id, loc := range locs {
		refs[id] = loc.BundleRef
	}
	return refs, nil
}

// OpenLooseBlob bypasses locator lookups for IDs omitted by LocateBundles on
// an already published tree, where a loose object must already be durable.
func OpenLooseBlob(ctx context.Context, s Store, id string) (io.ReadCloser, error) {
	b, lineage := bundleScope(s)
	if b == nil {
		return OpenReader(ctx, s, "o/"+id)
	}
	if !Lineage(lineage) || !root.Hex(id, 40) {
		return nil, fmt.Errorf("invalid loose blob key")
	}
	return OpenReader(ctx, b.Store, lineage+"/o/"+id)
}

// ReadBundle reads one immutable bundle. The size is reserved by the caller
// and verified before the bundle is exposed to the caller.
func ReadBundle(ctx context.Context, s Store, key string, size int64) ([]byte, error) {
	_, lineage := bundleScope(s)
	if !Lineage(lineage) {
		return nil, fmt.Errorf("bundle access requires a lineage")
	}
	return readBundle(ctx, s, lineage+"/"+key, key, size)
}

func readBundle(ctx context.Context, s Store, full, key string, size int64) ([]byte, error) {
	id, ok := strings.CutPrefix(key, "p/")
	if !ok || !root.Hex(id, 64) || size < 0 || size > BundleTargetBytes {
		return nil, fmt.Errorf("invalid bundle key or size")
	}
	// Scoped stores also accept full keys from their own lineage.
	r, err := OpenReader(ctx, s, full)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	data, err := readExact(r, size)
	if err != nil {
		return nil, err
	}
	if root.Hash(data) != id {
		return nil, fmt.Errorf("bundle digest mismatch")
	}
	return data, nil
}

func readExact(r io.Reader, size int64) ([]byte, error) {
	b := make([]byte, size)
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, fmt.Errorf("short object: %w", err)
	}
	var extra [1]byte
	_, err := io.ReadFull(r, extra[:])
	if err == nil {
		return nil, fmt.Errorf("oversized object")
	}
	if err != io.EOF {
		return nil, err
	}
	return b, nil
}

// PutSmallBlobs publishes immutable bundles before making their members
// visible. On a partial failure the map still reports successful placements.
func PutSmallBlobs(ctx context.Context, s Store, blobs []SmallBlob) (map[string]bool, error) {
	b, lineage := bundleScope(s)
	if b == nil || !Lineage(lineage) {
		return nil, fmt.Errorf("bundle writes require an enabled lineage store")
	}
	pending := make(map[string]SmallBlob, len(blobs))
	for _, blob := range blobs {
		if len(blob.Data) > BundleMaxBlob || BlobKey(blob.Data) != blob.Key || root.Hash(blob.Data) != blob.SHA256 {
			return nil, fmt.Errorf("invalid small blob %q", blob.Key)
		}
		id := strings.TrimPrefix(blob.Key, "o/")
		if prior, ok := pending[id]; ok && prior.SHA256 != blob.SHA256 {
			return nil, fmt.Errorf("blob %s conflicts with duplicate input", id)
		}
		pending[id] = blob
	}
	ids := make([]string, 0, len(pending))
	for id := range pending {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return b.putSmall(ctx, lineage, ids, pending)
}

func (s *bundled) putSmall(ctx context.Context, lineage string, ids []string, blobs map[string]SmallBlob) (map[string]bool, error) {
	locs, err := s.lookupBatch(ctx, lineage, ids)
	if err != nil {
		return nil, err
	}
	result := make(map[string]bool, len(ids))
	var mu sync.Mutex
	record := func(key string, created bool) {
		mu.Lock()
		defer mu.Unlock()
		result[key] = created
	}
	// Loose blobs created before packing remain canonical for the same ID.
	err = Parallel(ctx, min(bundleConcurrency, Depth(s)), ids, func(id string) error {
		blob := blobs[id]
		info := Info{Size: int64(len(blob.Data)), SHA256: blob.SHA256}
		if loc, ok := locs[id]; ok {
			if err := checkBlobInfo(id, Info{Size: loc.Size, SHA256: loc.SHA256}, info); err != nil {
				return err
			}
		} else {
			raw, err := s.Store.Head(ctx, lineage+"/"+blob.Key)
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if err := checkBlobInfo(id, raw, info); err != nil {
				return err
			}
		}
		record(blob.Key, false)
		return nil
	})
	if err != nil {
		return result, err
	}
	ids = slices.DeleteFunc(ids, func(id string) bool {
		_, found := result[blobs[id].Key]
		return found
	})
	for len(ids) > 0 {
		size, count := 0, 0
		for count < len(ids) {
			next := len(blobs[ids[count]].Data)
			if size+next > BundleTargetBytes {
				break
			}
			size += next
			count++
		}
		part := ids[:count]
		ids = ids[count:]
		if err := s.putBundle(ctx, lineage, part, blobs, size, record); err != nil {
			return result, err
		}
	}
	return result, nil
}

func (s *bundled) putBundle(ctx context.Context, lineage string, ids []string, blobs map[string]SmallBlob, size int, record func(string, bool)) error {
	payload := make([]byte, 0, size)
	offsets := make(map[string]int64, len(ids))
	for _, id := range ids {
		offsets[id] = int64(len(payload))
		payload = append(payload, blobs[id].Data...)
	}
	key := "p/" + root.Hash(payload)
	if err := s.Store.Put(ctx, lineage+"/"+key, payload); err != nil {
		return err
	}
	attempt := rand.Text()
	return Parallel(ctx, min(bundleConcurrency, Depth(s)), ids, func(id string) error {
		blob := blobs[id]
		ref := BundleRef{Key: key, SHA256: blob.SHA256, Offset: offsets[id], Size: int64(len(blob.Data)), PackSize: int64(size)}
		created, err := s.publish(ctx, lineage, id, blobLocation{BundleRef: ref, attempt: attempt})
		if err == nil {
			record(blob.Key, created)
		}
		return err
	})
}

func (s *bundled) putBlobFile(ctx context.Context, key string, file *os.File, info Info) (bool, error) {
	lineage, _, id, _ := splitKey(key)
	if info.Size <= BundleMaxBlob {
		// A failed locator must leave only the unreachable bundle payload.
		// Writing the loose key first could make a retry miscount it as legacy.
		data, err := readExact(file, info.Size)
		if err != nil {
			return false, err
		}
		blob := SmallBlob{Key: "o/" + id, SHA256: info.SHA256, Data: data}
		written, err := PutSmallBlobs(ctx, ForLineage(s, lineage), []SmallBlob{blob})
		return written[blob.Key], err
	}
	loc, err := s.lookup(ctx, lineage, id)
	if err != nil {
		return false, err
	}
	if loc.SHA256 != "" {
		return false, checkBlobInfo(id, Info{Size: loc.Size, SHA256: loc.SHA256}, info)
	}
	created, err := PutBlobFileIfAbsent(ctx, s.Store, key, file, info.SHA256)
	if err != nil {
		return false, err
	}
	if !created {
		raw, err := s.Store.Head(ctx, key)
		if err != nil {
			return false, err
		}
		return false, checkBlobInfo(id, raw, info)
	}
	return true, nil
}

func checkBlobInfo(id string, existing, wanted Info) error {
	if existing != wanted {
		return fmt.Errorf("blob %s conflicts with durable size or digest", id)
	}
	return nil
}
