package store

import (
	"os"
	"sync"
	"time"
)

var touchMu sync.Mutex

// TouchUsed bounds timestamp writes to one per minute per file, across callers.
func TouchUsed(path string, now time.Time) {
	touchMu.Lock()
	defer touchMu.Unlock()
	info, e := os.Stat(path)
	if e == nil && now.Sub(info.ModTime()) >= time.Minute {
		_ = os.Chtimes(path, now, now)
	}
}
