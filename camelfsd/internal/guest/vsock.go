package guest

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

type transport interface {
	io.ReadWriteCloser
	SetDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
}

func socket() (*os.File, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), "vsock"), nil
}

func ServeVM(ctx context.Context, repoDisk bool, r *reaper) error {
	listener, err := socket()
	if err != nil {
		return err
	}
	defer listener.Close()
	raw, err := listener.SyscallConn()
	if err != nil {
		return err
	}
	var sockErr error
	if err = raw.Control(func(fd uintptr) {
		sockErr = unix.Bind(int(fd), &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: 5000})
		if sockErr == nil {
			sockErr = unix.Listen(int(fd), 1)
		}
	}); err != nil {
		return err
	}
	if sockErr != nil {
		return sockErr
	}
	stop := context.AfterFunc(ctx, func() { listener.Close() })
	defer stop()
	g := &guest{root: "/", vm: true, vsock: repoDisk, reaper: r}
	defer g.sessions.close()
	for {
		var fd int
		err = raw.Read(func(s uintptr) bool {
			for {
				fd, _, sockErr = unix.Accept4(int(s), unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC)
				if sockErr != unix.EINTR {
					return sockErr != unix.EAGAIN && sockErr != unix.ECONNABORTED
				}
			}
		})
		if err != nil {
			return err
		}
		if sockErr != nil {
			return sockErr
		}
		conn := os.NewFile(uintptr(fd), "vsock:5000")
		exit, _ := g.serveChannel(ctx, conn, conn)
		conn.Close()
		if exit {
			return nil
		}
	}
}

func (g *guest) dial(ctx context.Context, port uint32, deadline time.Time) (transport, error) {
	if !g.vsock {
		d := net.Dialer{Deadline: deadline}
		suffix := "_5200"
		if port == 5201 {
			suffix = "_5201"
		}
		return d.DialContext(ctx, "unix", g.uds+suffix)
	}
	f, err := socket()
	if err != nil {
		return nil, err
	}
	if err = connectVM(ctx, f, port, deadline); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func connectVM(ctx context.Context, f *os.File, port uint32, deadline time.Time) error {
	stop := context.AfterFunc(ctx, func() { f.Close() })
	defer stop()
	if err := f.SetWriteDeadline(deadline); err != nil {
		return err
	}
	raw, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var sockErr error
	if err = raw.Control(func(fd uintptr) {
		sockErr = unix.Connect(int(fd), &unix.SockaddrVM{CID: 2, Port: port})
	}); err != nil {
		return err
	}
	if !errors.Is(sockErr, unix.EINPROGRESS) && !errors.Is(sockErr, unix.EINTR) {
		return sockErr
	}
	if err = raw.Write(func(fd uintptr) bool {
		var code int
		code, sockErr = unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_ERROR)
		if sockErr == nil && code != 0 {
			sockErr = unix.Errno(code)
		}
		// RawConn invokes the callback before polling, when SO_ERROR can still be zero.
		if sockErr == nil {
			_, sockErr = unix.Getpeername(int(fd))
		}
		return sockErr != unix.ENOTCONN && sockErr != unix.EINPROGRESS && sockErr != unix.EINTR
	}); err != nil {
		return err
	}
	return sockErr
}
