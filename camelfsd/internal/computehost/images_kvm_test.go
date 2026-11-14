//go:build linux && kvm

package computehost

import (
	"os"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// TestKVMGuestImageInstallBench times a host's first install of a published guest image (download, zstd sha,
// sparse decompress, sha256), as a boot or the registration prewarm would pay it.
//
//	CAMELFSD_KVM=1 CAMELFSD_IMAGE_BENCH_STORE=s3://bucket/prefix CAMELFSD_IMAGE_BENCH_SHA=<sha> go test -tags kvm
func TestKVMGuestImageInstallBench(t *testing.T) {
	url, sha := os.Getenv("CAMELFSD_IMAGE_BENCH_STORE"), os.Getenv("CAMELFSD_IMAGE_BENCH_SHA")
	if os.Getenv("CAMELFSD_KVM") != "1" || url == "" || sha == "" {
		t.Skip("set CAMELFSD_KVM=1, CAMELFSD_IMAGE_BENCH_STORE and CAMELFSD_IMAGE_BENCH_SHA on the KVM lane")
	}
	dir := os.Getenv("CAMELFSD_KVM_WORK")
	if dir == "" {
		dir = t.TempDir()
	} else {
		var err error
		if dir, err = os.MkdirTemp(dir, "image-bench-"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
	}
	s, err := store.Open(t.Context(), url, "us-west-2", 64)
	if err != nil {
		t.Fatal(err)
	}
	i := &images{dir: dir, store: s, diskMiB: 1 << 20}
	start := time.Now()
	path, err := i.ensure(t.Context(), sha, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(start)
	var st os.FileInfo
	if st, err = os.Stat(path); err != nil {
		t.Fatal(err)
	}
	t.Logf("RESULT image_install_ms=%d bytes=%d", elapsed.Milliseconds(), st.Size())
}
