package image

import (
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"golang.org/x/sys/unix"
)

type victim struct {
	path  string
	bytes int64
	used  time.Time
}

func (m *Manager) protect(job string, r root.Root, id string) {
	m.sweepMu.Lock()
	defer m.sweepMu.Unlock()
	if m.pins == nil {
		m.pins = map[string]map[string]bool{}
	}
	if m.pins[job] == nil {
		m.pins[job] = map[string]bool{}
	}
	m.pins[job][m.image(id)] = true
	for _, h := range r.Chunks {
		m.pins[job][filepath.Join(m.Cache.Dir, h[:2], h)] = true
	}
}
func (m *Manager) unprotect(job string) { m.sweepMu.Lock(); delete(m.pins, job); m.sweepMu.Unlock() }
func (m *Manager) maintain() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-t.C:
			e := m.sweep(0)
			if e != nil {
				log.Printf("op=evict error=%v", e)
			}
		}
	}
}
func (m *Manager) sweep(incoming int64) error {
	var st unix.Statfs_t
	if e := unix.Statfs(m.Data, &st); e != nil {
		return e
	}
	capacity := int64(st.Blocks) * int64(st.Bsize)
	used := int64(st.Blocks-st.Bavail) * int64(st.Bsize)
	if used+incoming <= capacity*80/100 {
		return nil
	}
	_, e := m.evict(used, capacity*60/100, func() (int64, error) {
		var current unix.Statfs_t
		if e := unix.Statfs(m.Data, &current); e != nil {
			return 0, e
		}
		return int64(current.Blocks-current.Bavail) * int64(current.Bsize), nil
	})
	return e
}

// evict is shared by the minute sweep and cold-mount admission. Live root
// chunks, mount files and their promoted snapshots are never candidates.
func (m *Manager) evict(used, low int64, usage ...func() (int64, error)) (freed int64, err error) {
	m.sweepMu.Lock()
	defer m.sweepMu.Unlock()
	start := time.Now()
	defer func() { log.Printf("op=evict bytesFreed=%d sweepMs=%.3f", freed, ms(start)) }()
	protected := map[string]bool{}
	for _, paths := range m.pins {
		for p := range paths {
			protected[p] = true
		}
	}
	var candidates []victim
	for _, dir := range []string{m.Cache.Dir, filepath.Join(m.Data, "images")} {
		e := filepath.WalkDir(dir, func(p string, d fs.DirEntry, e error) error {
			if os.IsNotExist(e) {
				return nil
			}
			if e != nil {
				return e
			}
			if d.IsDir() {
				return nil
			}
			name := d.Name()
			valid := root.Hex(name, 64) || len(name) == 68 && root.Hex(name[:64], 64) && name[64:] == ".img"
			if !valid || protected[p] {
				return nil
			}
			info, e := d.Info()
			if e != nil {
				return e
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			var st unix.Stat_t
			if e = unix.Lstat(p, &st); e != nil {
				return e
			}
			candidates = append(candidates, victim{p, st.Blocks * 512, info.ModTime()})
			return nil
		})
		if e != nil {
			return freed, e
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].used.Before(candidates[j].used) })
	for _, v := range candidates {
		if used-freed <= low {
			break
		}
		if e := os.Remove(v.path); e != nil && !os.IsNotExist(e) {
			return freed, e
		}
		freed += v.bytes
		if len(usage) > 0 {
			current, e := usage[0]()
			if e != nil {
				return freed, e
			}
			used = current + freed
		}
	}
	return freed, nil
}

// packWindows groups sparse chunk offsets into aligned bulk-pull windows.
// dm-clone owns destination writes; these windows are used by prehydrate mode.
func packWindows(r root.Root, size int64) [][]string {
	by := map[int64][]string{}
	for o := range r.Chunks {
		off, _ := strconv.ParseInt(o, 10, 64)
		key := off / size * size
		by[key] = append(by[key], o)
	}
	keys := make([]int64, 0, len(by))
	for k := range by {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	out := make([][]string, 0, len(keys))
	for _, k := range keys {
		v := by[k]
		sort.Slice(v, func(i, j int) bool {
			a, _ := strconv.ParseInt(v[i], 10, 64)
			b, _ := strconv.ParseInt(v[j], 10, 64)
			return a < b
		})
		out = append(out, v)
	}
	return out
}
