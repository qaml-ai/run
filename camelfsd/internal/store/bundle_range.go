package store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

func readBundleRange(ctx context.Context, s Store, key string, ref BundleRef) ([]byte, error) {
	switch v := s.(type) {
	case *scoped:
		full, err := v.key(key)
		if err != nil {
			return nil, err
		}
		return readBundleRange(ctx, v.Store, full, ref)
	case *bundled:
		return readBundleRange(ctx, v.Store, key, ref)
	case *limited:
		if err := v.acquire(ctx); err != nil {
			return nil, err
		}
		defer v.release(ctx)
		return readBundleRange(ctx, v.Store, key, ref)
	case *Uploaded:
		return readBundleRange(ctx, v.Store, key, ref)
	case *S3:
		object := v.key(key)
		last := ref.Offset + ref.Size - 1
		out, err := v.Client.GetObject(ctx, &s3.GetObjectInput{
			Bucket: &v.Bucket, Key: &object, Range: aws.String(fmt.Sprintf("bytes=%d-%d", ref.Offset, last)),
		})
		var missing *types.NoSuchKey
		if errors.As(err, &missing) {
			return nil, ioFailure(os.ErrNotExist)
		}
		if err != nil {
			return nil, ioFailure(err)
		}
		r := storeReader{out.Body}
		defer r.Close()
		expected := fmt.Sprintf("bytes %d-%d/%d", ref.Offset, last, ref.PackSize)
		if aws.ToString(out.ContentRange) != expected || aws.ToInt64(out.ContentLength) != ref.Size {
			return nil, fmt.Errorf("unexpected content range for bundle")
		}
		return readExact(r, ref.Size)
	default:
		r, err := OpenReader(ctx, s, key)
		if err != nil {
			return nil, err
		}
		defer r.Close()
		if _, err = io.CopyN(io.Discard, r, ref.Offset); err != nil {
			return nil, err
		}
		data := make([]byte, ref.Size)
		_, err = io.ReadFull(r, data)
		return data, err
	}
}
