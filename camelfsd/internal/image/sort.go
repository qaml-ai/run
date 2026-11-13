package image

import (
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func sortNBD(paths []string) {
	sort.Slice(paths, func(i, j int) bool {
		a, _ := strconv.Atoi(strings.TrimPrefix(filepath.Base(paths[i]), "nbd"))
		b, _ := strconv.Atoi(strings.TrimPrefix(filepath.Base(paths[j]), "nbd"))
		return a < b
	})
}
