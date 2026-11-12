// NBD framing and concurrent transmission promoted from prototypes/block/lazyblk.
package nbd

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"io"
	"net"
	"os"
	"strconv"
	"sync"
	"syscall"
)

type Server struct {
	Store      store.Store
	Cache      *cache.Cache
	Prefetch   int
	FetchDepth int
	Patterns   string
	mu         sync.Mutex
	origins    map[string]*origin
}
type device struct {
	r       root.Root
	s       *Server
	p       *origin
	release func()
}

func (s *Server) load(id string) (*device, error) {
	if !root.Hex(id, 64) {
		return nil, errors.New("invalid root")
	}
	b, e := s.Store.Get(context.Background(), "r/"+id)
	if e != nil {
		return nil, e
	}
	if root.Hash(b) != id {
		return nil, errors.New("root hash mismatch")
	}
	r, e := root.Decode(b)
	if e != nil {
		return nil, e
	}
	release := s.Register(id, "", r)
	s.mu.Lock()
	p := s.origins[id]
	s.mu.Unlock()
	return &device{r: r, s: s, p: p, release: release}, nil
}

// v0-limitation: L15
func (s *Server) Serve(l net.Listener) error {
	for {
		c, e := l.Accept()
		if e != nil {
			return e
		}
		go func() { _ = s.ServeConn(c) }()
	}
}
func (d *device) readAt(buf []byte, offset int64) error {
	for len(buf) > 0 {
		o := offset / root.ChunkSize * root.ChunkSize
		in := offset - o
		n := min(int(root.ChunkSize-in), len(buf))
		if d.p != nil {
			d.p.touch(o)
		}
		h := d.r.Chunks[strconv.FormatInt(o, 10)]
		if h == "" {
			clear(buf[:n])
		} else {
			if e := d.s.Cache.ReadAt(h, buf[:n], in); e != nil {
				return e
			}

		}
		if d.p != nil {
			d.p.ahead(o)
		}
		buf = buf[n:]
		offset += int64(n)
	}
	return nil
}

const (
	nbdMagic       = 0x4e42444d41474943
	nbdOptMagic    = 0x49484156454F5054
	nbdRepMagic    = 0x3e889045565a9
	nbdReqMagic    = 0x25609513
	nbdReplyMagic  = 0x67446698
	optExportName  = 1
	optAbort       = 2
	optGo          = 7
	optInfo        = 6
	repAck         = 1
	repInfo        = 3
	repErrUnsup    = 1<<31 | 1
	flagFixedNew   = 1
	flagNoZeroes   = 2
	txHasFlags     = 1
	txReadOnly     = 2
	txSendFlush    = 4
	txSendTrim     = 32
	txCanMultiConn = 256
	nbdRead        = 0
	nbdWrite       = 1
	nbdDisc        = 2
	nbdFlush       = 3
	nbdTrim        = 4
	nbdWriteZeroes = 6
)

func (s *Server) ServeConn(c net.Conn) error {
	var d *device
	defer c.Close()
	defer func() {
		if d != nil && d.release != nil {
			d.release()
		}
	}()
	if tc, ok := c.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
	}
	w := bufio.NewWriterSize(c, 1<<20)
	r := bufio.NewReaderSize(c, 1<<20)
	be := binary.BigEndian
	hdr := make([]byte, 18)
	be.PutUint64(hdr, nbdMagic)
	be.PutUint64(hdr[8:], nbdOptMagic)
	be.PutUint16(hdr[16:], flagFixedNew|flagNoZeroes)
	w.Write(hdr)
	w.Flush()
	var clientFlags uint32
	if err := binary.Read(r, be, &clientFlags); err != nil {
		return err
	}
	noZeroes := clientFlags&flagNoZeroes != 0
	txFlags := uint16(txHasFlags | txSendFlush | txSendTrim | txCanMultiConn)
	txFlags |= txReadOnly
	reply := func(opt, typ uint32, data []byte) {
		b := make([]byte, 20)
		be.PutUint64(b, nbdRepMagic)
		be.PutUint32(b[8:], opt)
		be.PutUint32(b[12:], typ)
		be.PutUint32(b[16:], uint32(len(data)))
		w.Write(b)
		w.Write(data)
		w.Flush()
	}
	for {
		var magic uint64
		var opt, n uint32
		if err := binary.Read(r, be, &magic); err != nil {
			return err
		}
		if magic != nbdOptMagic {
			return errors.New("bad option magic")
		}
		binary.Read(r, be, &opt)
		binary.Read(r, be, &n)
		if n > 1<<20 {
			return errors.New("option too large")
		}
		data := make([]byte, n)
		if _, err := io.ReadFull(r, data); err != nil {
			return err
		}
		switch opt {
		case optExportName:
			var err error
			d, err = s.load(string(data))
			if err != nil {
				return err
			}
			b := make([]byte, 10)
			be.PutUint64(b, uint64(d.r.VirtualSize))
			be.PutUint16(b[8:], txFlags)
			w.Write(b)
			if !noZeroes {
				w.Write(make([]byte, 124))
			}
			w.Flush()
			return d.transmission(c, r, w)
		case optGo, optInfo:
			if len(data) < 6 {
				return errors.New("bad GO")
			}
			sz := int(be.Uint32(data))
			if sz > len(data)-6 {
				return errors.New("bad export name")
			}
			var err error
			if d != nil && d.release != nil {
				d.release()
				d = nil
			}
			d, err = s.load(string(data[4 : 4+sz]))
			if err != nil {
				reply(opt, 1<<31|6, nil)
				continue
			}
			info := make([]byte, 12)
			be.PutUint16(info, 0) // NBD_INFO_EXPORT
			be.PutUint64(info[2:], uint64(d.r.VirtualSize))
			be.PutUint16(info[10:], txFlags)
			reply(opt, repInfo, info)
			reply(opt, repAck, nil)
			if opt == optGo {
				return d.transmission(c, r, w)
			}
		case optAbort:
			reply(opt, repAck, nil)
			return nil
		default:
			reply(opt, repErrUnsup, nil)
		}
	}
}

func (d *device) transmission(c net.Conn, r *bufio.Reader, w *bufio.Writer) error {
	be := binary.BigEndian
	var wmu sync.Mutex
	var wg sync.WaitGroup
	defer wg.Wait()
	// v0-limitation: L19
	slots := make(chan struct{}, 64)
	send := func(cookie uint64, errno uint32, data []byte) {
		wmu.Lock()
		defer wmu.Unlock()
		b := make([]byte, 16)
		be.PutUint32(b, nbdReplyMagic)
		be.PutUint32(b[4:], errno)
		be.PutUint64(b[8:], cookie)
		w.Write(b)
		w.Write(data)
		w.Flush()
	}
	req := make([]byte, 28)
	for {
		if _, err := io.ReadFull(r, req); err != nil {
			return err
		}
		if be.Uint32(req) != nbdReqMagic {
			return errors.New("bad request magic")
		}
		typ := be.Uint16(req[6:])
		cookie := be.Uint64(req[8:])
		offset := int64(be.Uint64(req[16:]))
		length := int(be.Uint32(req[24:]))
		if length > 32<<20 {
			return errors.New("request too large")
		}
		if offset < 0 || offset > d.r.VirtualSize || int64(length) > d.r.VirtualSize-offset {
			send(cookie, uint32(syscall.EINVAL), nil)
			if typ == nbdWrite {
				if _, e := io.CopyN(io.Discard, r, int64(length)); e != nil {
					return e
				}
			}
			continue
		}
		switch typ {
		case nbdRead:
			slots <- struct{}{}
			wg.Add(1)
			go func() {
				defer func() { <-slots; wg.Done() }()
				buf := make([]byte, length)
				if err := d.readAt(buf, offset); err != nil {
					fmt.Fprintln(os.Stderr, "read:", err)
					send(cookie, uint32(syscall.EIO), nil)
					return
				}
				send(cookie, 0, buf)
			}()
		case nbdWrite:
			buf := make([]byte, length)
			if _, err := io.ReadFull(r, buf); err != nil {
				return err
			}
			send(cookie, uint32(syscall.EROFS), nil)
		case nbdFlush:
			send(cookie, 0, nil)
		case nbdTrim, nbdWriteZeroes:
			send(cookie, uint32(syscall.EROFS), nil)
		case nbdDisc:
			return nil
		default:
			send(cookie, uint32(syscall.EINVAL), nil)
		}
	}
}
