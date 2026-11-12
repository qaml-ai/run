package main

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
)

// Each chunk has its own SplitMix64 stream; generating one never depends on others.
func fillChunk(dst []byte, seed int64, index int) {
	x := mix64(uint64(seed) ^ mix64(uint64(index)+0x9e3779b97f4a7c15))
	for pos := 0; pos < len(dst); {
		x += 0x9e3779b97f4a7c15
		z := mix64(x)
		for j := 0; j < 8 && pos < len(dst); j++ {
			dst[pos] = byte(z)
			z >>= 8
			pos++
		}
	}
}
func mix64(z uint64) uint64 {
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}
func perPack(layout string, size int) (int, error) {
	if layout == "chunk" {
		return 1, nil
	}
	capacity := 0
	switch layout {
	case "pack1m":
		capacity = 1 << 20
	case "pack4m", "range4m":
		capacity = 4 << 20
	default:
		return 0, fmt.Errorf("unknown layout %q", layout)
	}
	if size <= 0 || size > capacity || capacity%size != 0 {
		return 0, fmt.Errorf("chunk size must divide %d bytes for %s", capacity, layout)
	}
	return capacity / size, nil
}
func objectKey(prefix, layout string, index int) string {
	return fmt.Sprintf("%s/%s/%08d", strings.TrimRight(prefix, "/"), layout, index)
}
func neededChunks(n int, fraction float64, seed int64) []int {
	count := int(math.Ceil(fraction * float64(n)))
	if count == n {
		out := make([]int, n)
		for i := range out {
			out[i] = i
		}
		return out
	}
	out := rand.New(rand.NewSource(seed)).Perm(n)[:count]
	sort.Ints(out)
	return out
}

type request struct {
	key, byteRange     string
	first, count, size int
}

func plan(prefix, mode string, n, size int, needed []int) ([]request, error) {
	pp, err := perPack(mode, size)
	if err != nil {
		return nil, err
	}
	out := make([]request, 0, len(needed))
	seen := map[int]bool{}
	for _, i := range needed {
		p := i / pp
		if mode == "range4m" {
			start := (i % pp) * size
			out = append(out, request{objectKey(prefix, "pack4m", p), fmt.Sprintf("bytes=%d-%d", start, start+size-1), i, 1, size})
		} else if !seen[p] {
			seen[p] = true
			count := min(pp, n-p*pp)
			out = append(out, request{objectKey(prefix, mode, p), "", p * pp, count, count * size})
		}
	}
	return out, nil
}
