//go:build linux && kvm

package computehost

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// The prototype only accepts a canonical committed tree. It never reads a
// guest's disk. The generated ext4 image is immutable after mkfs.
type portableImage struct {
	Version, Tree, SHA256, Path        string
	VirtualSize, CompressedSize        int64
	Entries                            []objects.Entry
	Build, Materialize, Mkfs, Compress time.Duration
}

func buildPortableImage(ctx context.Context, repo *objects.Repository, source store.Store, version, tree, dir string, virtualSize int64) (out portableImage, err error) {
	start := time.Now()
	out.Version, out.Tree, out.VirtualSize = version, tree, virtualSize
	commit, err := repo.Object(ctx, version, "commit")
	if err != nil || !bytes.HasPrefix(commit, []byte("tree "+tree+"\n")) {
		return out, fmt.Errorf("canonical image commit/tree mismatch: %w", err)
	}
	out.Entries, err = repo.TreeEntries(ctx, tree)
	if err != nil {
		return out, err
	}
	ids := make([]string, 0, len(out.Entries))
	for _, entry := range out.Entries {
		if err := objects.Path(entry.Path); err != nil {
			return out, err
		}
		if entry.Size <= store.BundleMaxBlob {
			ids = append(ids, entry.SHA1)
		}
	}
	locations, err := store.LocateBundlesForRestore(ctx, source, ids)
	if err != nil {
		return out, err
	}
	stage := filepath.Join(dir, "files")
	if err := os.Mkdir(stage, 0755); err != nil {
		return out, err
	}
	groups := map[string][]objects.Entry{}
	var loose []string
	looseEntries := make(map[string]objects.Entry)
	for _, entry := range out.Entries {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(stage, entry.Path)), 0755); err != nil {
			return out, err
		}
		if ref, ok := locations[entry.SHA1]; ok {
			if ref.Size != entry.Size || !store.ValidateBundleRef(ref) {
				return out, fmt.Errorf("invalid clean image blob locator")
			}
			if group := groups[ref.Key]; len(group) > 0 && locations[group[0].SHA1].PackSize != ref.PackSize {
				return out, fmt.Errorf("inconsistent clean image pack size")
			}
			groups[ref.Key] = append(groups[ref.Key], entry)
		} else {
			loose = append(loose, entry.Path)
			looseEntries[entry.Path] = entry
		}
	}
	for key, entries := range groups {
		ref := locations[entries[0].SHA1]
		pack, err := store.ReadBundle(ctx, source, key, ref.PackSize)
		if err != nil {
			return out, err
		}
		for _, entry := range entries {
			ref := locations[entry.SHA1]
			if err := materializePortableBlob(stage, entry, bytes.NewReader(pack[ref.Offset:ref.Offset+ref.Size])); err != nil {
				return out, err
			}
		}
	}
	err = store.Parallel(ctx, 32, loose, func(path string) error {
		entry := looseEntries[path]
		r, err := store.OpenLooseBlob(ctx, source, entry.SHA1)
		if err != nil {
			return err
		}
		defer r.Close()
		return materializePortableBlob(stage, entry, r)
	})
	if err != nil {
		return out, err
	}
	out.Materialize = time.Since(start)
	image := filepath.Join(dir, "clean.ext4")
	f, err := os.OpenFile(image, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return out, err
	}
	err = f.Truncate(virtualSize)
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return out, fmt.Errorf("create clean disk: %v %v", err, closeErr)
	}
	mkfsStart := time.Now()
	cmd := exec.CommandContext(ctx, "mkfs.ext4", "-q", "-F", "-E", "lazy_itable_init=1,lazy_journal_init=1", "-O", "^inline_data", "-J", "size=128", "-d", stage, image)
	if output, err := cmd.CombinedOutput(); err != nil {
		return out, fmt.Errorf("mkfs clean image: %w: %s", err, output)
	}
	out.Mkfs = time.Since(mkfsStart)
	out.Path = filepath.Join(dir, "clean.ext4.gz")
	startCompress := time.Now()
	artifact, err := os.OpenFile(out.Path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return out, err
	}
	hash := sha256.New()
	z, err := gzip.NewWriterLevel(io.MultiWriter(artifact, hash), gzip.BestSpeed)
	if err != nil {
		artifact.Close()
		return out, err
	}
	input, err := os.Open(image)
	if err != nil {
		artifact.Close()
		return out, err
	}
	_, err = io.Copy(z, input)
	input.Close()
	if closeErr := z.Close(); err == nil {
		err = closeErr
	}
	if syncErr := artifact.Sync(); err == nil {
		err = syncErr
	}
	if closeErr := artifact.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return out, err
	}
	info, err := os.Stat(out.Path)
	if err != nil {
		return out, err
	}
	out.SHA256, out.CompressedSize = hex.EncodeToString(hash.Sum(nil)), info.Size()
	out.Compress, out.Build = time.Since(startCompress), time.Since(start)
	return out, nil
}

func materializePortableBlob(stage string, entry objects.Entry, body io.Reader) error {
	if entry.Size < 0 {
		return fmt.Errorf("invalid image blob length")
	}
	f, err := os.OpenFile(filepath.Join(stage, entry.Path), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	hash := sha1.New()
	fmt.Fprintf(hash, "blob %d\x00", entry.Size)
	n, err := io.CopyN(io.MultiWriter(f, hash), body, entry.Size)
	var extra [1]byte
	_, eof := io.ReadFull(body, extra[:])
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil || n != entry.Size || eof != io.EOF || hex.EncodeToString(hash.Sum(nil)) != entry.SHA1 {
		return fmt.Errorf("image blob mismatch: %s", entry.Path)
	}
	switch entry.Mode {
	case "100644":
		return os.Chmod(f.Name(), 0644)
	case "100755":
		return os.Chmod(f.Name(), 0755)
	case "120000":
		raw, err := os.ReadFile(f.Name())
		if err != nil {
			return err
		}
		if err := os.Remove(f.Name()); err != nil {
			return err
		}
		return os.Symlink(string(raw), f.Name())
	default:
		return fmt.Errorf("unsupported clean image mode %s", entry.Mode)
	}
}

// Verify the compressed object and exact decoded length before publishing the
// sparse cache file. A failed transfer leaves no advertised image.
func restorePortableImage(ctx context.Context, input io.Reader, image portableImage, data, lineage string) (err error) {
	dir := filepath.Join(data, "workspace-images")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".clean-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	hash := sha256.New()
	limited := &io.LimitedReader{R: io.TeeReader(input, hash), N: image.CompressedSize + 1}
	z, err := gzip.NewReader(limited)
	if err != nil {
		return err
	}
	defer z.Close()
	buf, zero := make([]byte, 64<<10), make([]byte, 64<<10)
	var size int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := io.ReadFull(z, buf)
		if size+int64(n) > image.VirtualSize {
			return fmt.Errorf("clean image decoded past declared size")
		}
		if n > 0 && !bytes.Equal(buf[:n], zero[:n]) {
			if _, err := f.WriteAt(buf[:n], size); err != nil {
				return err
			}
		}
		size += int64(n)
		if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if size != image.VirtualSize || limited.N != 1 || hex.EncodeToString(hash.Sum(nil)) != image.SHA256 {
		return fmt.Errorf("clean image length or compressed digest mismatch")
	}
	if err := f.Truncate(size); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), filepath.Join(dir, image.SHA256+".img")); err != nil {
		return err
	}
	db, err := refs.Open(filepath.Join(data, "refs.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	return db.RecordTree(lineage, image.Tree, image.SHA256)
}

func portableImageS3(t *testing.T, url string) (*s3.Client, string, string) {
	t.Helper()
	bucket, prefix, ok := strings.Cut(strings.TrimPrefix(url, "s3://"), "/")
	if !ok || bucket == "" || prefix == "" {
		t.Fatal("portable image requires a scoped S3 prefix")
	}
	cfg, err := config.LoadDefaultConfig(t.Context(), config.WithRegion("us-west-2"))
	if err != nil {
		t.Fatal(err)
	}
	return s3.NewFromConfig(cfg), bucket, strings.TrimRight(prefix, "/")
}

func uploadPortableImage(t *testing.T, client *s3.Client, bucket, prefix, lineage string, image portableImage) string {
	t.Helper()
	key := prefix + "/" + lineage + "/clean/" + image.SHA256 + ".gz"
	f, err := os.Open(image.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	start := time.Now()
	_, err = client.PutObject(t.Context(), &s3.PutObjectInput{Bucket: aws.String(bucket), Key: aws.String(key), Body: f, ContentLength: aws.Int64(image.CompressedSize)})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("CLEAN_IMAGE_BUILD tree=%s version=%s files=%d virtual_bytes=%d compressed_bytes=%d materialize_ms=%d mkfs_ms=%d compress_ms=%d total_ms=%d upload_ms=%d", image.Tree, image.Version, len(image.Entries), image.VirtualSize, image.CompressedSize, image.Materialize.Milliseconds(), image.Mkfs.Milliseconds(), image.Compress.Milliseconds(), image.Build.Milliseconds(), time.Since(start).Milliseconds())
	return key
}

func TestPortableImageLocalBench(t *testing.T) {
	if os.Getenv("CAMELFSD_CLEAN_IMAGE_LOCAL") != "1" {
		t.Skip("set CAMELFSD_CLEAN_IMAGE_LOCAL=1 on a Sprite")
	}
	for _, mb := range []int{50, 500} {
		t.Run(fmt.Sprintf("%dMiB", mb), func(t *testing.T) {
			ctx := t.Context()
			seed := t.TempDir()
			db, err := refs.OpenStorage(filepath.Join(seed, "seed.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			backing := store.Local{Dir: filepath.Join(seed, "objects")}
			repo := &objects.Repository{DB: db, Store: backing, TempDir: seed}
			files := map[string]objects.File{}
			for i := 0; i < 10000+mb-40; i++ {
				size, path := 4096, fmt.Sprintf("src/d%03d/f%05d.ts", i/100, i)
				if i >= 10000 {
					size, path = 1<<20, fmt.Sprintf("assets/a%04d.bin", i-10000)
				}
				raw := make([]byte, size)
				if _, err := rand.Read(raw); err != nil {
					t.Fatal(err)
				}
				sum := sha256.Sum256(raw)
				id := hex.EncodeToString(sum[:])
				if _, err := repo.Upload(ctx, "fixture", id, int64(size), bytes.NewReader(raw)); err != nil {
					t.Fatal(err)
				}
				files[path] = objects.File{SHA256: id}
			}
			tree, err := repo.Import(ctx, objects.Request{Lineage: "fixture", Files: files})
			if err != nil {
				t.Fatal(err)
			}
			scoped := repo.ForLineage("fixture")
			version, err := scoped.PutObject(ctx, "fixture", "commit", []byte("tree "+tree.Tree+"\nauthor Bench <bench@example.com> 1000 +0000\ncommitter Bench <bench@example.com> 1000 +0000\n\ncanonical fixture\n"))
			if err != nil {
				t.Fatal(err)
			}
			for round := 1; round <= 2; round++ {
				dir, data := t.TempDir(), t.TempDir()
				image, err := buildPortableImage(ctx, scoped, store.ForLineage(backing, "fixture"), version, tree.Tree, dir, int64(mb+1024)<<20)
				if err != nil {
					t.Fatal(err)
				}
				input, err := os.Open(image.Path)
				if err != nil {
					t.Fatal(err)
				}
				restoreStart := time.Now()
				err = restorePortableImage(ctx, input, image, data, "fixture")
				input.Close()
				if err != nil {
					t.Fatal(err)
				}
				restore := time.Since(restoreStart)
				// debugfs only reads this brand-new host-generated image.
				extracted := filepath.Join(data, "extracted")
				if err := os.Mkdir(extracted, 0700); err != nil {
					t.Fatal(err)
				}
				readStart := time.Now()
				disk := filepath.Join(data, "workspace-images", image.SHA256+".img")
				cmd := exec.CommandContext(ctx, "debugfs", "-R", "rdump / "+extracted, disk)
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("extract generated image: %v %s", err, output)
				}
				for _, entry := range image.Entries {
					f, err := os.Open(filepath.Join(extracted, entry.Path))
					if err != nil {
						t.Fatal(err)
					}
					hash := sha1.New()
					fmt.Fprintf(hash, "blob %d\x00", entry.Size)
					n, err := io.Copy(hash, f)
					f.Close()
					if err != nil || n != entry.Size || hex.EncodeToString(hash.Sum(nil)) != entry.SHA1 {
						t.Fatalf("restored tree blob mismatch: %s", entry.Path)
					}
				}
				t.Logf("CLEAN_LOCAL_RESULT size_mb=%d round=%d files=%d virtual_bytes=%d compressed_bytes=%d materialize_ms=%d mkfs_ms=%d compress_ms=%d producer_ms=%d restore_ms=%d debugfs_read_verify_ms=%d", mb, round, len(image.Entries), image.VirtualSize, image.CompressedSize, image.Materialize.Milliseconds(), image.Mkfs.Milliseconds(), image.Compress.Milliseconds(), image.Build.Milliseconds(), restore.Milliseconds(), time.Since(readStart).Milliseconds())
				if err := os.RemoveAll(dir); err != nil {
					t.Fatal(err)
				}
				if err := os.RemoveAll(data); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestPortableImageValidation(t *testing.T) {
	raw := make([]byte, 1<<20)
	raw[128<<10] = 1
	var compressed bytes.Buffer
	z := gzip.NewWriter(&compressed)
	if _, err := z.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(compressed.Bytes())
	image := portableImage{Tree: strings.Repeat("b", 40), SHA256: hex.EncodeToString(digest[:]), VirtualSize: int64(len(raw)), CompressedSize: int64(compressed.Len())}
	for _, scenario := range []string{"valid", "digest", "overflow", "short", "truncated"} {
		t.Run(scenario, func(t *testing.T) {
			data := t.TempDir()
			want := image
			body := compressed.Bytes()
			switch scenario {
			case "digest":
				want.SHA256 = strings.Repeat("a", 64)
			case "overflow":
				want.VirtualSize--
			case "short":
				want.VirtualSize++
			case "truncated":
				body = body[:len(body)-1]
			}
			err := restorePortableImage(t.Context(), bytes.NewReader(body), want, data, "fixture")
			if scenario != "valid" {
				if err == nil {
					t.Fatal("invalid image accepted")
				}
				matches, err := filepath.Glob(filepath.Join(data, "workspace-images", "*"))
				if err != nil || len(matches) != 0 {
					t.Fatalf("invalid image was published: %v %v", matches, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(filepath.Join(data, "workspace-images", want.SHA256+".img"))
			if err != nil || !bytes.Equal(got, raw) {
				t.Fatalf("sparse decode mismatch: %v", err)
			}
			refsDB, err := refs.Open(filepath.Join(data, "refs.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer refsDB.Close()
			root, err := refsDB.TreeRoot("fixture", want.Tree)
			if err != nil || root != want.SHA256 {
				t.Fatalf("published cache identity: %q %v", root, err)
			}
		})
	}
	for _, mode := range []string{"100644", "100755", "120000"} {
		t.Run(mode, func(t *testing.T) {
			stage := t.TempDir()
			content := []byte("safe-target")
			hash := sha1.New()
			fmt.Fprintf(hash, "blob %d\x00", len(content))
			hash.Write(content)
			entry := objects.Entry{Path: "file", Mode: mode, SHA1: hex.EncodeToString(hash.Sum(nil)), Size: int64(len(content))}
			if err := materializePortableBlob(stage, entry, bytes.NewReader(content)); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(stage, "file")
			info, err := os.Lstat(file)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "120000" {
				target, err := os.Readlink(file)
				if err != nil || target != string(content) {
					t.Fatalf("symlink: %q %v", target, err)
				}
			} else if (mode == "100755") != (info.Mode().Perm()&0111 != 0) {
				t.Fatalf("file mode: %s", info.Mode())
			}
		})
	}
}

func TestDDBPortableImageLargeLooseBlob(t *testing.T) {
	client, table := contractTable(t, "lineage", "id")
	ctx := t.Context()
	dir := t.TempDir()
	db, err := refs.OpenStorage(filepath.Join(dir, "seed.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	backing := store.WithBundles(store.Local{Dir: filepath.Join(dir, "objects")}, client, table)
	repo := (&objects.Repository{DB: db, Store: backing, TempDir: dir}).ForLineage("fixture")
	publication := repo.BeginPublication()
	small := []byte("packed small file")
	smallBlob := publication.StageBlob(small)
	smallSum := sha256.Sum256(small)
	smallBlob.SHA256 = hex.EncodeToString(smallSum[:])
	if err := publication.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	large := bytes.Repeat([]byte("x"), store.BundleMaxBlob+1)
	sum := sha256.Sum256(large)
	largeBlob, err := repo.Upload(ctx, "fixture", hex.EncodeToString(sum[:]), int64(len(large)), bytes.NewReader(large))
	if err != nil {
		t.Fatal(err)
	}
	source := store.ForLineage(backing, "fixture")
	if _, err := store.LocateBundlesForRestore(ctx, source, []string{smallBlob.SHA1, largeBlob.SHA1}); err == nil {
		t.Fatal("fixture did not reproduce missing locator for the large loose blob")
	}
	locators, err := store.LocateBundlesForRestore(ctx, source, []string{smallBlob.SHA1})
	if err != nil || len(locators) != 1 {
		t.Fatalf("small blob is not packed: %v %v", locators, err)
	}
	tree, err := repo.Import(ctx, objects.Request{Lineage: "fixture", Files: map[string]objects.File{
		"small": {SHA256: smallBlob.SHA256}, "large": {SHA256: largeBlob.SHA256},
	}})
	if err != nil {
		t.Fatal(err)
	}
	version, err := repo.PutObject(ctx, "fixture", "commit", []byte("tree "+tree.Tree+"\nauthor Bench <bench@example.com> 1000 +0000\ncommitter Bench <bench@example.com> 1000 +0000\n\ncanonical fixture\n"))
	if err != nil {
		t.Fatal(err)
	}
	image, err := buildPortableImage(ctx, repo, source, version, tree.Tree, t.TempDir(), 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	if len(image.Entries) != 2 || image.CompressedSize == 0 {
		t.Fatalf("canonical mixed-size image: %+v", image)
	}
}
