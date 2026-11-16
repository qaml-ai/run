package image

import (
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"os"
)

func clone(src, dst string) error {
	return cloneImage(src, dst, true)
}

func cloneImage(src, dst string, sync bool) error {
	f, e := os.Open(src)
	if e != nil {
		return e
	}
	defer f.Close()
	g, e := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	ok := false
	defer func() {
		g.Close()
		if !ok {
			os.Remove(dst)
		}
	}()
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") == "1" {
		_, e = io.Copy(g, f)
	} else {
		e = unix.IoctlFileClone(int(g.Fd()), int(f.Fd()))
	}
	if e == nil && sync {
		e = g.Sync()
	}
	ok = e == nil
	return e
}
func Probe(dir string) error {
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") == "1" {
		return nil
	}
	f, e := os.CreateTemp(dir, ".probe-")
	if e != nil {
		return e
	}
	p := f.Name()
	defer os.Remove(p)
	defer os.Remove(p + ".clone")
	_, e = f.Write(make([]byte, 4096))
	f.Close()
	if e != nil {
		return e
	}
	if e = clone(p, p+".clone"); e != nil {
		return fmt.Errorf("data requires FICLONE: %w", e)
	}
	return nil
}
