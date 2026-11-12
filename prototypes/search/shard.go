package main

// A shard is the unit of indexing: an immutable set of content-addressed blobs and the trigram postings over them.
// Its id is the SHA-256 of its sorted blob list, so two builders that index the same blobs write the same shard.
//
//	<id>.idx   header | blob table | trigram table | postings          (the index proper, mmapped)
//	<id>.dat   the blobs' bytes, concatenated                          (verification content; see DESIGN.md §content)
//
// Postings are document-level (which blobs contain a trigram), not positional: verification re-scans the candidate
// blob, which keeps the index at ~25-40% of the content instead of Zoekt's ~300%.

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"syscall"
)

const (
	shardMagic   = "CRSHRD01"
	blobEntrySz  = 20 + 8 + 4 + 4 // sha1, content offset, length, flags
	triEntrySz   = 4 + 8 + 4      // trigram, postings offset, count
	headerSz     = 8 + 4 + 4 + 8*3
	flagBinary   = 1 // contains NUL: content kept, no trigrams
	flagTooLarge = 2 // over maxIndexBytes: no content, no trigrams
)

const maxIndexBytes = 1 << 20

type BlobID [20]byte

func (b BlobID) String() string { return hex.EncodeToString(b[:]) }

func parseBlobID(s string) (BlobID, error) {
	var b BlobID
	if len(s) != 40 {
		return b, fmt.Errorf("bad blob id %q", s)
	}
	_, err := hex.Decode(b[:], []byte(s))
	return b, err
}

// pendingBlob is a blob on its way into a shard.
type pendingBlob struct {
	ID      BlobID
	Content []byte
	Ext     string // a representative path extension, for the symbol pass
}

type Shard struct {
	ID    string
	idx   []byte // mmapped .idx
	dat   []byte // mmapped .dat
	nBlob int
	nTri  int
	blobs []byte // blob table slice of idx
	tris  []byte // trigram table slice of idx
	post  []byte // postings slice of idx
	syms  *SymbolTable
}

// lowerASCII folds A-Z only; the index is built over folded bytes and queries are folded the same way.
func lowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 32
	}
	return c
}

// docTrigrams returns the distinct folded trigrams of content, sorted, reusing buf.
func docTrigrams(content []byte, buf []uint32) []uint32 {
	buf = buf[:0]
	if len(content) < 3 {
		return buf
	}
	t := uint32(lowerASCII(content[0]))<<8 | uint32(lowerASCII(content[1]))
	for i := 2; i < len(content); i++ {
		t = (t<<8 | uint32(lowerASCII(content[i]))) & 0xffffff
		buf = append(buf, t)
	}
	slices.Sort(buf)
	return slices.Compact(buf)
}

// buildShard writes one shard from blobs (already deduplicated) into dir and returns its id and sizes.
func buildShard(dir string, blobs []pendingBlob, withSymbols bool) (string, int64, int64, error) {
	sort.Slice(blobs, func(i, j int) bool { return bytes.Compare(blobs[i].ID[:], blobs[j].ID[:]) < 0 })
	h := sha256.New()
	for _, b := range blobs {
		h.Write(b.ID[:])
	}
	id := hex.EncodeToString(h.Sum(nil))[:32]
	idxPath := filepath.Join(dir, id+".idx")
	if st, err := os.Stat(idxPath); err == nil { // content-addressed: already built
		dst, _ := os.Stat(filepath.Join(dir, id+".dat"))
		return id, st.Size(), dst.Size(), nil
	}

	// (trigram<<32 | ordinal) pairs, appended in ordinal order; a stable radix sort on the trigram then yields each
	// trigram's postings in ordinal order. A bitset (2 MiB, reset via the touched list) dedups trigrams within a blob.
	var pairs []uint64
	seen := make([]uint64, 1<<24/64)
	var touched []uint32
	blobTab := make([]byte, len(blobs)*blobEntrySz)
	var dat bytes.Buffer
	for i, b := range blobs {
		var flags uint32
		content := b.Content
		if len(content) > maxIndexBytes {
			flags |= flagTooLarge
			content = nil
		} else if bytes.IndexByte(content, 0) >= 0 {
			flags |= flagBinary
		}
		e := blobTab[i*blobEntrySz:]
		copy(e, b.ID[:])
		binary.LittleEndian.PutUint64(e[20:], uint64(dat.Len()))
		binary.LittleEndian.PutUint32(e[28:], uint32(len(content)))
		binary.LittleEndian.PutUint32(e[32:], flags)
		dat.Write(content)
		if flags == 0 && len(content) >= 3 {
			t := uint32(lowerASCII(content[0]))<<8 | uint32(lowerASCII(content[1]))
			for k := 2; k < len(content); k++ {
				t = (t<<8 | uint32(lowerASCII(content[k]))) & 0xffffff
				if seen[t>>6]&(1<<(t&63)) == 0 {
					seen[t>>6] |= 1 << (t & 63)
					touched = append(touched, t)
					pairs = append(pairs, uint64(t)<<32|uint64(i))
				}
			}
			for _, t := range touched {
				seen[t>>6] = 0
			}
			touched = touched[:0]
		}
	}
	pairs = radixByTrigram(pairs)

	var triTab []byte
	var post []byte
	var tmp [binary.MaxVarintLen64]byte
	for i := 0; i < len(pairs); {
		t := uint32(pairs[i] >> 32)
		start := len(post)
		prev := uint32(0)
		n := 0
		for ; i < len(pairs) && uint32(pairs[i]>>32) == t; i++ {
			ord := uint32(pairs[i])
			k := binary.PutUvarint(tmp[:], uint64(ord-prev))
			post = append(post, tmp[:k]...)
			prev = ord
			n++
		}
		var e [triEntrySz]byte
		binary.LittleEndian.PutUint32(e[0:], t)
		binary.LittleEndian.PutUint64(e[4:], uint64(start))
		binary.LittleEndian.PutUint32(e[12:], uint32(n))
		triTab = append(triTab, e[:]...)
	}

	hdr := make([]byte, headerSz)
	copy(hdr, shardMagic)
	binary.LittleEndian.PutUint32(hdr[8:], uint32(len(blobs)))
	binary.LittleEndian.PutUint32(hdr[12:], uint32(len(triTab)/triEntrySz))
	binary.LittleEndian.PutUint64(hdr[16:], uint64(headerSz))
	binary.LittleEndian.PutUint64(hdr[24:], uint64(headerSz+len(blobTab)))
	binary.LittleEndian.PutUint64(hdr[32:], uint64(headerSz+len(blobTab)+len(triTab)))

	if err := writeAtomic(filepath.Join(dir, id+".dat"), dat.Bytes()); err != nil {
		return "", 0, 0, err
	}
	if withSymbols {
		if err := buildSymbols(dir, id, blobs); err != nil {
			return "", 0, 0, err
		}
	}
	idx := slices.Concat(hdr, blobTab, triTab, post)
	if err := writeAtomic(idxPath, idx); err != nil {
		return "", 0, 0, err
	}
	return id, int64(len(idx)), int64(dat.Len()), nil
}

func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func mmapFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() == 0 {
		return []byte{}, nil
	}
	return syscall.Mmap(int(f.Fd()), 0, int(st.Size()), syscall.PROT_READ, syscall.MAP_SHARED)
}

func openShard(dir, id string) (*Shard, error) {
	idx, err := mmapFile(filepath.Join(dir, id+".idx"))
	if err != nil {
		return nil, err
	}
	if len(idx) < headerSz || string(idx[:8]) != shardMagic {
		return nil, errors.New("bad shard " + id)
	}
	dat, err := mmapFile(filepath.Join(dir, id+".dat"))
	if err != nil {
		return nil, err
	}
	s := &Shard{ID: id, idx: idx, dat: dat}
	s.nBlob = int(binary.LittleEndian.Uint32(idx[8:]))
	s.nTri = int(binary.LittleEndian.Uint32(idx[12:]))
	bo := binary.LittleEndian.Uint64(idx[16:])
	to := binary.LittleEndian.Uint64(idx[24:])
	po := binary.LittleEndian.Uint64(idx[32:])
	s.blobs = idx[bo:to]
	s.tris = idx[to:po]
	s.post = idx[po:]
	s.syms, _ = openSymbols(dir, id) // optional
	return s, nil
}

func (s *Shard) blobID(ord int) (b BlobID) {
	copy(b[:], s.blobs[ord*blobEntrySz:])
	return
}

func (s *Shard) blobFlags(ord int) uint32 {
	return binary.LittleEndian.Uint32(s.blobs[ord*blobEntrySz+32:])
}

func (s *Shard) content(ord int) []byte {
	e := s.blobs[ord*blobEntrySz:]
	off := binary.LittleEndian.Uint64(e[20:])
	n := binary.LittleEndian.Uint32(e[28:])
	return s.dat[off : off+uint64(n)]
}

// postings returns the sorted ordinals of blobs containing folded trigram t.
func (s *Shard) postings(t uint32, out []uint32) []uint32 {
	out = out[:0]
	i := sort.Search(s.nTri, func(i int) bool { return binary.LittleEndian.Uint32(s.tris[i*triEntrySz:]) >= t })
	if i == s.nTri || binary.LittleEndian.Uint32(s.tris[i*triEntrySz:]) != t {
		return out
	}
	e := s.tris[i*triEntrySz:]
	off := binary.LittleEndian.Uint64(e[4:])
	n := int(binary.LittleEndian.Uint32(e[12:]))
	p := s.post[off:]
	v := uint32(0)
	for k := 0; k < n; k++ {
		d, m := binary.Uvarint(p)
		p = p[m:]
		v += uint32(d)
		out = append(out, v)
	}
	return out
}

func (s *Shard) postingCount(t uint32) int {
	i := sort.Search(s.nTri, func(i int) bool { return binary.LittleEndian.Uint32(s.tris[i*triEntrySz:]) >= t })
	if i == s.nTri || binary.LittleEndian.Uint32(s.tris[i*triEntrySz:]) != t {
		return 0
	}
	return int(binary.LittleEndian.Uint32(s.tris[i*triEntrySz+12:]))
}

// radixByTrigram stable-sorts pairs by their 24-bit trigram (bits 32..55): two 12-bit LSD passes.
func radixByTrigram(a []uint64) []uint64 {
	b := make([]uint64, len(a))
	for shift := uint(32); shift < 56; shift += 12 {
		var count [1 << 12]int
		for _, v := range a {
			count[(v>>shift)&0xfff]++
		}
		sum := 0
		for i, c := range count {
			count[i] = sum
			sum += c
		}
		for _, v := range a {
			k := (v >> shift) & 0xfff
			b[count[k]] = v
			count[k]++
		}
		a, b = b, a
	}
	return a
}
