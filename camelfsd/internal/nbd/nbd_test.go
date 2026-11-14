package nbd

import (
	"bytes"
	"context"
	"encoding/binary"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestHandshakeReadAndReadonly(t *testing.T) {
	for _, goOpt := range []bool{false, true} {
		t.Run(strconv.FormatBool(goOpt), func(t *testing.T) {
			ctx := context.Background()
			s := store.Local{Dir: t.TempDir()}
			payload := make([]byte, root.ChunkSize)
			copy(payload, "hello NBD")
			h := root.Hash(payload)
			if e := s.Put(ctx, "l/c/"+h, payload); e != nil {
				t.Fatal(e)
			}
			r := root.Root{V: 1, FSType: "ext4", VirtualSize: 2 * root.ChunkSize, Chunks: map[string]string{"0": h}}
			b, _ := root.Encode(r)
			id := root.Hash(b)
			if e := s.Put(ctx, "l/r/"+id, b); e != nil {
				t.Fatal(e)
			}
			server, conn := net.Pipe()
			defer conn.Close()
			conn.SetDeadline(time.Now().Add(5 * time.Second))
			done := make(chan error, 1)
			go func() {
				done <- (&Server{Store: s, Cache: cache.New(filepath.Join(t.TempDir(), "cache"), s, 4), Prefetch: 4}).ServeConn(server)
			}()
			read := func(n int) []byte {
				t.Helper()
				b := make([]byte, n)
				if _, e := io.ReadFull(conn, b); e != nil {
					t.Fatal(e)
				}
				return b
			}
			write := func(b []byte) {
				t.Helper()
				if _, e := conn.Write(b); e != nil {
					t.Fatal(e)
				}
			}
			be := binary.BigEndian
			hdr := read(18)
			if be.Uint64(hdr) != nbdMagic {
				t.Fatal("magic")
			}
			write(be.AppendUint32(nil, 3))
			opt := uint32(optExportName)
			export := "l/" + id
			data := []byte(export)
			if goOpt {
				opt = optGo
				data = be.AppendUint32(nil, uint32(len(export)))
				data = append(data, []byte(export)...)
				data = be.AppendUint16(data, 0)
			}
			b = be.AppendUint64(nil, nbdOptMagic)
			b = be.AppendUint32(b, opt)
			b = be.AppendUint32(b, uint32(len(data)))
			write(append(b, data...))
			if goOpt {
				rep := read(20)
				if be.Uint32(rep[12:]) != repInfo {
					t.Fatal("info")
				}
				info := read(int(be.Uint32(rep[16:])))
				if be.Uint64(info[2:]) != uint64(r.VirtualSize) {
					t.Fatal("size")
				}
				rep = read(20)
				if be.Uint32(rep[12:]) != repAck {
					t.Fatal("ack")
				}
			} else {
				ex := read(10)
				if be.Uint64(ex) != uint64(r.VirtualSize) || be.Uint16(ex[8:])&txReadOnly == 0 {
					t.Fatal("export")
				}
			}
			req := func(typ uint16, offset uint64, n uint32) {
				b := be.AppendUint32(nil, nbdReqMagic)
				b = be.AppendUint16(b, 0)
				b = be.AppendUint16(b, typ)
				b = be.AppendUint64(b, 42)
				b = be.AppendUint64(b, offset)
				b = be.AppendUint32(b, n)
				write(b)
			}
			req(nbdRead, 0, 9)
			rep := read(16)
			if be.Uint32(rep[4:]) != 0 || string(read(9)) != "hello NBD" {
				t.Fatal("read")
			}
			req(nbdRead, uint64(root.ChunkSize), 512)
			read(16)
			if !bytes.Equal(read(512), make([]byte, 512)) {
				t.Fatal("hole")
			}
			req(nbdWrite, 0, 1)
			write([]byte{1})
			if be.Uint32(read(16)[4:]) != 30 {
				t.Fatal("write not EROFS")
			}
			req(nbdDisc, 0, 0)
			if e := <-done; e != nil {
				t.Fatal(e)
			}
		})
	}
}
