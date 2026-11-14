package vmhost

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"

	"golang.org/x/sys/unix"
)

func cloneDisk(ctx context.Context, source, target string, size int64, reflink string) error {
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer dst.Close()
	if err := unix.IoctlFileClone(int(dst.Fd()), int(src.Fd())); err != nil {
		if reflink != "auto" {
			return fmt.Errorf("reflink base image: %w", err)
		}
		if _, err := io.Copy(dst, src); err != nil {
			return err
		}
	}
	if err := dst.Truncate(size); err != nil {
		return err
	}
	if err := dst.Close(); err != nil {
		return err
	}
	if out, err := exec.CommandContext(ctx, "resize2fs", "-f", target).CombinedOutput(); err != nil {
		return fmt.Errorf("resize2fs: %w: %s", err, out)
	}
	return nil
}

func mountAsset(source, target string, readOnly bool, uid int) error {
	var st unix.Stat_t
	if err := unix.Stat(source, &st); err != nil {
		return err
	}
	kind := st.Mode & unix.S_IFMT
	if !readOnly && kind == unix.S_IFBLK {
		// Give the jail its own device node so permissions on the host's
		// source node remain intact.
		if err := unix.Mknod(target, unix.S_IFBLK|0600, int(st.Rdev)); err != nil {
			return err
		}
		return os.Chown(target, uid, uid)
	}
	if kind != unix.S_IFREG {
		return fmt.Errorf("%s must be a regular file or a repo block device", source)
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := unix.Mount(source, target, "", unix.MS_BIND, ""); err != nil {
		return err
	}
	if readOnly {
		return unix.Mount("", target, "", unix.MS_REMOUNT|unix.MS_BIND|unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, "")
	}
	return nil
}
