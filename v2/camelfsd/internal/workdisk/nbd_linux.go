package workdisk

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Linux NBD ioctls, defined in linux/nbd.h. The socket starts in transmission
// mode because this process configures both sides of the device.
const (
	nbdSetSock    = 0xab00
	nbdSetBlkSize = 0xab01
	nbdDoIt       = 0xab03
	nbdClearSock  = 0xab04
	nbdSetBlocks  = 0xab07
	nbdDisconnect = 0xab08
	nbdSetFlags   = 0xab0a
)

type Device struct {
	Path   string
	device *os.File
	peer   *os.File
	cancel context.CancelFunc
	kernel chan error
	server chan error
}

func (v *View) Attach(ctx context.Context, paths []string) (*Device, error) {
	if v.Size()%4096 != 0 {
		return nil, fmt.Errorf("workspace disk is not 4 KiB aligned")
	}
	for _, path := range paths {
		dev, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			return nil, err
		}
		if err := unix.Flock(int(dev.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
			_ = dev.Close()
			if errors.Is(err, unix.EWOULDBLOCK) {
				continue
			}
			return nil, err
		}
		info, err := dev.Stat()
		if err != nil || info.Mode()&(os.ModeDevice|os.ModeCharDevice) != os.ModeDevice {
			_ = dev.Close()
			return nil, fmt.Errorf("invalid workspace NBD block device %s", path)
		}
		conn, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
		if err != nil {
			_ = dev.Close()
			return nil, err
		}
		kernel := os.NewFile(uintptr(conn[0]), "nbd-kernel")
		peer := os.NewFile(uintptr(conn[1]), "nbd-server")
		ioctl := func(req uint, arg int) error { return unix.IoctlSetInt(int(dev.Fd()), req, arg) }
		if err := ioctl(nbdSetSock, int(kernel.Fd())); err != nil {
			_ = kernel.Close()
			_ = peer.Close()
			_ = dev.Close()
			if errors.Is(err, unix.EBUSY) {
				continue
			}
			return nil, fmt.Errorf("attach %s: %w", path, err)
		}
		_ = kernel.Close()
		for _, setting := range []struct {
			req uint
			arg int
		}{
			{nbdSetBlkSize, 4096}, {nbdSetBlocks, int(v.Size() / 4096)}, {nbdSetFlags, 1 | 4},
		} {
			if err := ioctl(setting.req, setting.arg); err != nil {
				_ = ioctl(nbdClearSock, 0)
				_ = peer.Close()
				_ = dev.Close()
				return nil, fmt.Errorf("configure %s: %w", path, err)
			}
		}
		serveCtx, cancel := context.WithCancel(context.Background())
		d := &Device{Path: path, device: dev, peer: peer, cancel: cancel, kernel: make(chan error, 1), server: make(chan error, 1)}
		go func() {
			defer close(d.kernel)
			d.kernel <- ioctl(nbdDoIt, 0)
		}()
		go func() {
			err := v.serveNBD(serveCtx, peer)
			_ = unix.Shutdown(int(peer.Fd()), unix.SHUT_RDWR)
			d.server <- err
		}()
		if err := d.waitReady(ctx, v.Size()); err != nil {
			_ = d.Close()
			return nil, err
		}
		return d, nil
	}
	return nil, fmt.Errorf("all configured workspace NBD devices are busy")
}

func (d *Device) waitReady(ctx context.Context, size int64) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	sys := filepath.Join("/sys/class/block", filepath.Base(d.Path))
	want := strconv.FormatInt(size/512, 10)
	for {
		_, pidErr := os.Stat(filepath.Join(sys, "pid"))
		sectors, sizeErr := os.ReadFile(filepath.Join(sys, "size"))
		if pidErr == nil && sizeErr == nil && strings.TrimSpace(string(sectors)) == want {
			return nil
		}
		select {
		case err := <-d.kernel:
			return fmt.Errorf("%s detached during setup: %v", d.Path, err)
		case <-ctx.Done():
			return fmt.Errorf("wait for %s: %w", d.Path, ctx.Err())
		case <-ticker.C:
		}
	}
}

func (d *Device) Close() error {
	d.cancel()
	fd := int(d.device.Fd())
	_ = unix.IoctlSetInt(fd, nbdDisconnect, 0)
	_ = unix.Shutdown(int(d.peer.Fd()), unix.SHUT_RDWR)
	<-d.kernel
	_ = unix.IoctlSetInt(fd, nbdClearSock, 0)
	<-d.server
	return errors.Join(d.peer.Close(), d.device.Close())
}

func (v *View) serveNBD(ctx context.Context, conn io.ReadWriter) error {
	const (
		reqMagic = 0x25609513
		repMagic = 0x67446698
	)
	be := binary.BigEndian
	var header [28]byte
	var reply [16]byte
	be.PutUint32(reply[:], repMagic)
	for {
		if _, err := io.ReadFull(conn, header[:]); err != nil {
			return err
		}
		op := be.Uint32(header[4:8])
		offset := int64(be.Uint64(header[16:24]))
		size := be.Uint32(header[24:])
		if be.Uint32(header[:4]) != reqMagic || size > 32<<20 {
			return fmt.Errorf("invalid NBD request")
		}
		if op == 2 {
			return nil // disconnect
		}
		var data []byte
		var err error
		switch op {
		case 0, 1:
			data = make([]byte, size)
			if op == 1 {
				if _, err := io.ReadFull(conn, data); err != nil {
					return err
				}
			}
			err = v.Transfer(ctx, op == 1, offset, data)
		case 3:
			// This is a private overlay. Durability is established by commit publication.
		default:
			err = fmt.Errorf("unsupported NBD command %d", op)
		}
		status := uint32(0)
		if err != nil {
			status = uint32(unix.EIO)
		}
		be.PutUint32(reply[4:8], status)
		copy(reply[8:], header[8:16])
		if _, err := conn.Write(reply[:]); err != nil {
			return err
		}
		if status == 0 && op == 0 {
			if _, err := conn.Write(data); err != nil {
				return err
			}
		}
	}
}
