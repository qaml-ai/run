package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

const (
	WorkspaceImageFormat = 1
	// Changing the mkfs/compression recipe requires a new profile or format.
	WorkspaceImageProfile          = "ext4-mkfs-v1-gzip-fast"
	workspaceDescriptorLimit       = 4096
	workspaceSinglePutLimit  int64 = 5 << 30
	workspacePartSize        int64 = 64 << 20
)

// WorkspaceImage is a derived image of an exact canonical tree and disk shape.
// Blob is relative to Lineage. Neither image kind participates in Git quota or
// blob reachability. The canonical tree remains the source of truth.
type WorkspaceImage struct {
	Format      int    `json:"format"`
	Lineage     string `json:"lineage"`
	Tree        string `json:"tree"`
	Blob        string `json:"blob"`
	SHA256      string `json:"sha256"`
	RawSHA256   string `json:"rawSha256"`
	VirtualSize int64  `json:"virtualSize"`
	StoredSize  int64  `json:"storedSize"`
}

// WorkspaceImageKey returns the relative immutable descriptor key. A different
// lineage, tree, virtual size or image recipe cannot reuse the descriptor.
func WorkspaceImageKey(lineage, tree string, size int64) (string, error) {
	if !Lineage(lineage) || !root.Hex(tree, 40) || size <= 0 {
		return "", fmt.Errorf("invalid workspace image identity")
	}
	identity := fmt.Sprintf("workspace-image\x00%d\x00%s\x00%s\x00%s\x00%d", WorkspaceImageFormat, WorkspaceImageProfile, lineage, tree, size)
	return "i/" + root.Hash([]byte(identity)), nil
}

func (d WorkspaceImage) key() (string, error) {
	if d.Format != WorkspaceImageFormat || !root.Hex(d.SHA256, 64) || !root.Hex(d.RawSHA256, 64) || d.Blob != "w/"+d.SHA256 || d.StoredSize <= 0 {
		return "", fmt.Errorf("invalid workspace image descriptor")
	}
	return WorkspaceImageKey(d.Lineage, d.Tree, d.VirtualSize)
}

func decodeWorkspaceImage(raw []byte) (WorkspaceImage, error) {
	var d WorkspaceImage
	if len(raw) > workspaceDescriptorLimit {
		return d, fmt.Errorf("oversized workspace image descriptor")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		return d, fmt.Errorf("invalid workspace image descriptor: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return d, fmt.Errorf("trailing workspace image descriptor data")
	}
	_, err := d.key()
	return d, err
}

// GetWorkspaceImage distinguishes an absent descriptor from every other error.
// Referenced payload absence, corruption and availability are checked by the
// caller during verified restoration, and must never become cache misses.
func GetWorkspaceImage(ctx context.Context, s Store, lineage, tree string, size int64) (WorkspaceImage, bool, error) {
	key, err := WorkspaceImageKey(lineage, tree, size)
	if err != nil {
		return WorkspaceImage{}, false, err
	}
	r, err := OpenReader(ctx, s, lineage+"/"+key)
	if errors.Is(err, os.ErrNotExist) {
		return WorkspaceImage{}, false, nil
	}
	if err != nil {
		return WorkspaceImage{}, false, err
	}
	raw, err := io.ReadAll(io.LimitReader(r, workspaceDescriptorLimit+1))
	err = errors.Join(err, r.Close())
	if err != nil {
		return WorkspaceImage{}, false, err
	}
	d, err := decodeWorkspaceImage(raw)
	if err != nil {
		return d, false, err
	}
	actual, err := d.key()
	if err != nil || d.Lineage != lineage || actual != key {
		return d, false, fmt.Errorf("workspace image identity mismatch")
	}
	return d, true, nil
}

// PublishWorkspaceImage uploads verified immutable bytes before conditionally
// publishing the descriptor. Concurrent builders may produce different ext4
// bytes. All adopt the same first published descriptor. Partial uploads cannot
// create a ready descriptor. Unreferenced losing payloads are derived garbage.
func PublishWorkspaceImage(ctx context.Context, s Store, d WorkspaceImage, f *os.File) (WorkspaceImage, error) {
	key, err := d.key()
	if err != nil {
		return WorkspaceImage{}, err
	}
	if winner, found, err := GetWorkspaceImage(ctx, s, d.Lineage, d.Tree, d.VirtualSize); err != nil || found {
		return winner, err
	}
	if err := verifyWorkspaceFile(ctx, f, d); err != nil {
		return WorkspaceImage{}, err
	}
	if err := putWorkspaceFile(ctx, s, d.Lineage+"/"+d.Blob, f, d.StoredSize, d.SHA256); err != nil {
		return WorkspaceImage{}, err
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return WorkspaceImage{}, err
	}
	if err := s.Put(ctx, d.Lineage+"/"+key, raw); err != nil {
		return WorkspaceImage{}, err
	}
	winner, found, err := GetWorkspaceImage(ctx, s, d.Lineage, d.Tree, d.VirtualSize)
	if err == nil && !found {
		err = fmt.Errorf("published workspace image descriptor missing")
	}
	return winner, err
}

func verifyWorkspaceFile(ctx context.Context, f *os.File, d WorkspaceImage) error {
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.Size() != d.StoredSize {
		return fmt.Errorf("workspace image stored size mismatch")
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	h := sha256.New()
	if n, err := io.Copy(h, blobReadContext{ctx, f}); err != nil {
		return err
	} else if n != d.StoredSize || fmt.Sprintf("%x", h.Sum(nil)) != d.SHA256 {
		return fmt.Errorf("workspace image payload digest mismatch")
	}
	_, err = f.Seek(0, io.SeekStart)
	return err
}

func putWorkspaceFile(ctx context.Context, s Store, key string, f *os.File, size int64, digest string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	switch v := s.(type) {
	case *scoped:
		full, err := v.key(key)
		if err != nil {
			return err
		}
		return putWorkspaceFile(ctx, v.Store, full, f, size, digest)
	case *bundled:
		return putWorkspaceFile(ctx, v.Store, key, f, size, digest)
	case *Uploaded:
		return putWorkspaceFile(ctx, v.Store, key, f, size, digest)
	case *limited:
		if err := v.acquire(ctx); err != nil {
			return err
		}
		defer v.release(ctx)
		return putWorkspaceFile(ctx, v.Store, key, f, size, digest)
	case Local:
		dst := filepath.Join(v.Dir, key)
		if err := os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
			return ioFailure(err)
		}
		tmp, err := os.CreateTemp(filepath.Dir(dst), ".tmp-")
		if err != nil {
			return ioFailure(err)
		}
		defer os.Remove(tmp.Name())
		n, err := io.Copy(tmp, blobReadContext{ctx, f})
		if err == nil && n != size {
			err = fmt.Errorf("workspace image changed during publication")
		}
		if err == nil {
			err = tmp.Sync()
		}
		err = errors.Join(err, tmp.Close())
		if err != nil {
			return ioFailure(err)
		}
		err = os.Link(tmp.Name(), dst)
		if errors.Is(err, os.ErrExist) {
			return ioFailure(SyncDir(filepath.Dir(dst)))
		}
		if err == nil {
			err = SyncDir(filepath.Dir(dst))
		}
		return ioFailure(err)
	case *S3:
		return v.putWorkspaceFile(ctx, key, f, size, digest)
	default:
		return fmt.Errorf("store %T does not support workspace image publication", s)
	}
}

func conditionalConflict(err error) (exists, retry bool) {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		return apiErr.ErrorCode() == "PreconditionFailed", apiErr.ErrorCode() == "ConditionalRequestConflict"
	}
	return false, false
}

func (s *S3) putWorkspaceFile(ctx context.Context, key string, f *os.File, size int64, digest string) error {
	key = s.key(key)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		var err error
		if size > workspaceSinglePutLimit {
			err = s.multipartWorkspaceFile(ctx, key, f, size, digest)
		} else {
			_, err = s.Client.PutObject(ctx, &s3.PutObjectInput{Bucket: &s.Bucket, Key: &key, Body: io.NewSectionReader(f, 0, size), ContentLength: &size, IfNoneMatch: aws.String("*"), Metadata: map[string]string{"x-camel-sha256": digest}})
		}
		exists, retry := conditionalConflict(err)
		if exists {
			return nil
		}
		if retry {
			continue
		}
		return ioFailure(err)
	}
}

func (s *S3) multipartWorkspaceFile(ctx context.Context, key string, f *os.File, size int64, digest string) (err error) {
	upload, err := s.Client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: &s.Bucket, Key: &key, Metadata: map[string]string{"x-camel-sha256": digest}})
	if err != nil {
		return err
	}
	completed := false
	defer func() {
		if !completed {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			_, abortErr := s.Client.AbortMultipartUpload(cleanup, &s3.AbortMultipartUploadInput{Bucket: &s.Bucket, Key: &key, UploadId: upload.UploadId})
			err = errors.Join(err, abortErr)
		}
	}()
	var parts []types.CompletedPart
	for offset := int64(0); offset < size; offset += workspacePartSize {
		length := min(workspacePartSize, size-offset)
		number := int32(len(parts) + 1)
		part, err := s.Client.UploadPart(ctx, &s3.UploadPartInput{Bucket: &s.Bucket, Key: &key, UploadId: upload.UploadId, PartNumber: &number, ContentLength: &length, Body: io.NewSectionReader(f, offset, length)})
		if err != nil {
			return err
		}
		parts = append(parts, types.CompletedPart{ETag: part.ETag, PartNumber: &number})
	}
	_, err = s.Client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{Bucket: &s.Bucket, Key: &key, UploadId: upload.UploadId, MultipartUpload: &types.CompletedMultipartUpload{Parts: parts}, IfNoneMatch: aws.String("*")})
	completed = err == nil
	return err
}
