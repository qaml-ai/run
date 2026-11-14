package guest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"golang.org/x/sys/unix"
)

func freezeRepo(path string) (func() error, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	// linux/fs.h: _IOWR('X', 119/120, int) on amd64.
	const freeze, thaw = 0xc0045877, 0xc0045878
	err = unix.IoctlSetInt(int(f.Fd()), freeze, 0)
	return func() error {
		defer f.Close()
		return unix.IoctlSetInt(int(f.Fd()), thaw, 0)
	}, err
}

func (g *guest) checkpointConn(ctx context.Context, start time.Time) (transport, error) {
	ready := minTime(start.Add(connectBudget), deadline(ctx))
	for time.Now().Before(ready) && ctx.Err() == nil {
		c, err := g.dial(ctx, 5200, ready)
		if err == nil {
			c.SetDeadline(ready)
			stop := interruptRead(ctx, c)
			var first struct{ Ready bool }
			err = wire.JSON(c, &first)
			stop()
			if err == nil && first.Ready {
				return c, nil
			}
			c.Close()
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return nil, errors.New("checkpoint connect timed out after 10 s")
}

func (g *guest) checkpoint(parent context.Context, req request) (result message, err error) {
	if g.index == nil {
		return nil, errors.New("no camelFS index: apply did not run")
	}
	if g.pending != nil {
		return nil, errors.New("checkpoint already pending")
	}
	ctx, cancel := streamContext(parent, req.TimeoutMs)
	defer cancel()
	defer func() { err = streamError(ctx, err, "checkpoint") }()
	if err = g.checkMount(); err != nil {
		return nil, err
	}
	var c transport
	var streamStart time.Time
	var stop func() bool
	connect := func() error {
		streamStart = time.Now()
		conn, err := g.checkpointConn(ctx, streamStart)
		if err != nil {
			return err
		}
		c = conn
		stop = interruptRead(ctx, c)
		return c.SetDeadline(deadline(ctx))
	}
	trailerSent := false
	defer func() {
		if c == nil {
			return
		}
		defer c.Close()
		defer stop()
		if err != nil && ctx.Err() == nil && time.Now().Before(deadline(ctx)) && !trailerSent {
			wire.Send(c, message{"end": true, "error": errorText(err)})
		}
	}()
	// Legacy jobhost arms port 5200 first and expects the connect wait to
	// stay outside freezeMs. Session checkpoints walk before opening it.
	if req.LegacyCheckpoint {
		if err = connect(); err != nil {
			return nil, err
		}
	}
	frozenAt := time.Now()
	freeze := g.freeze
	if freeze == nil && g.vsock {
		freeze = func() (func() error, error) { return freezeRepo(g.repo) }
	}
	var thaw func() error
	defer func() {
		if thaw != nil {
			thawErr := thaw()
			if err == nil {
				err = thawErr
			}
		}
		if err == nil {
			result["freezeMs"] = elapsed(frozenAt)
		} else {
			g.pending = nil
			g.pendingEntries = nil
		}
	}()
	if freeze != nil {
		thaw, err = freeze()
		if err != nil {
			return nil, err
		}
	}
	walkStart := time.Now()
	ops, bytes, skipped, err := g.diff(ctx)
	if err != nil {
		return nil, err
	}
	walkMs := elapsed(walkStart)
	if len(ops) == 0 && !req.LegacyCheckpoint {
		return message{"changed": false, "files": 0, "bytes": 0, "walkMs": walkMs}, nil
	}
	if !req.LegacyCheckpoint {
		if err = connect(); err != nil {
			return nil, err
		}
	}
	if err = wire.Send(c, message{"v": 1, "kind": "checkpoint", "jobId": req.JobID, "baseTree": g.index.Tree, "walkMs": walkMs}); err != nil {
		return nil, err
	}
	buffer := make([]byte, wire.DataMax)
	for _, op := range ops {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		if err = wire.Send(c, op); err != nil {
			return nil, err
		}
		if op.Op == "put" {
			if err = g.sendFile(c, op, buffer); err != nil {
				return nil, err
			}
		}
	}
	if err = wire.Send(c, message{"end": true, "files": len(ops), "bytes": bytes, "freezeMs": elapsed(frozenAt), "skipped": skipped}); err != nil {
		return nil, err
	}
	trailerSent = true
	streamMs := elapsed(streamStart)
	var ack struct {
		Ack   bool
		Error *string
	}
	if err = wire.JSON(c, &ack); err != nil {
		return nil, readError(err, "unexpected EOF awaiting checkpoint ack")
	}
	if !ack.Ack {
		if ack.Error != nil {
			return nil, errors.New(*ack.Error)
		}
		return nil, errors.New("invalid checkpoint ack")
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if g.session {
		// Save the stat values for the tree that was streamed while frozen.
		// Writes by a live exec after thaw must show up in the next checkpoint.
		g.pendingEntries = make(map[string]entry, len(ops))
		for _, op := range ops {
			if op.Op == "del" {
				continue
			}
			item, _, e := snapshot(op.Path, filepath.Join(g.repo, op.Path), "")
			if e != nil {
				return nil, e
			}
			g.pendingEntries[op.Path] = item
		}
	}
	g.pending = ops
	result = message{"walkMs": walkMs, "streamMs": streamMs, "files": len(ops), "bytes": bytes, "skipped": skipped}
	if !req.LegacyCheckpoint {
		result["changed"] = true
	}
	return result, nil
}

func (g *guest) diff(ctx context.Context) ([]operation, int64, int, error) {
	ops := []operation{}
	old := make(map[string]entry, len(g.index.Entries))
	for _, e := range g.index.Entries {
		old[e.Path] = e
	}
	var bytes int64
	skipped := 0
	seen := make(map[string]bool, len(old))
	err := walkRepo(g.repo, func(full, path string, d fs.DirEntry) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == ".git" || strings.HasPrefix(d.Name(), ".camelfs-tmp-") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if err := checkPath(path); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		current, mode, err := snapshot(path, full, "")
		if err != nil {
			return err
		}
		link := current.Mode == "120000"
		if !mode.IsRegular() && !link {
			skipped++
			return nil
		}
		seen[path] = true
		prior, known := old[path]
		same := known && prior.Ino == current.Ino && prior.Size == current.Size &&
			prior.Mtime == current.Mtime && (prior.Mode == "120000") == link
		switch {
		case same && prior.Ctime == current.Ctime && prior.Mode == current.Mode:
		case same && prior.Mode != current.Mode && prior.Ctime != current.Ctime && !link:
			ops = append(ops, operation{Path: path, Op: "mode", Mode: current.Mode})
		case link:
			target, err := os.Readlink(full)
			if err != nil {
				return err
			}
			ops = append(ops, operation{Path: path, Op: "link", Target: &target})
		default:
			size, err := strconv.ParseInt(current.Size, 10, 64)
			if err != nil || !validSize(&size) {
				return fmt.Errorf("file too large: %s", path)
			}
			ops = append(ops, operation{Path: path, Op: "put", Mode: current.Mode, Size: &size})
			bytes += size
		}
		return nil
	})
	if err != nil {
		return nil, 0, 0, err
	}
	for _, e := range g.index.Entries {
		if err := ctx.Err(); err != nil {
			return nil, 0, 0, err
		}
		if seen[e.Path] {
			continue
		}
		temporary := false
		for _, part := range strings.Split(e.Path, "/") {
			if strings.HasPrefix(part, ".camelfs-tmp-") {
				temporary = true
				break
			}
		}
		if temporary {
			continue
		}
		if err := checkPath(e.Path); err != nil {
			return nil, 0, 0, err
		}
		ops = append(ops, operation{Path: e.Path, Op: "del"})
	}
	return ops, bytes, skipped, nil
}

func (g *guest) sendFile(w io.Writer, op operation, buf []byte) error {
	f, err := os.OpenFile(filepath.Join(g.repo, op.Path), os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	for left := *op.Size; left > 0; {
		n, err := io.ReadFull(f, buf[:min(left, int64(len(buf)))])
		if err != nil {
			return readError(err, fmt.Sprintf("file shorter than walked size: %s", op.Path))
		}
		if err = wire.Write(w, buf[:n]); err != nil {
			return err
		}
		left -= int64(n)
	}
	n, err := f.Read(buf[:1])
	if n != 0 {
		return fmt.Errorf("file larger than walked size: %s", op.Path)
	}
	if err == io.EOF {
		return nil
	}
	return err
}

func (g *guest) checkpointed(req request) (message, error) {
	if g.session && g.pending == nil && g.index != nil && (req.Error != nil || req.Tree == g.index.Tree) {
		return message{"entries": len(g.index.Entries)}, nil
	}
	if g.pending == nil || g.index == nil {
		return nil, errors.New("no pending checkpoint")
	}
	if req.Error != nil {
		g.pending = nil
		g.pendingEntries = nil
		return message{"entries": len(g.index.Entries)}, nil
	}
	if !checkpointTree.MatchString(req.Tree) {
		return nil, errors.New("invalid checkpoint tree")
	}
	changes := make(map[string]entry, len(g.pending))
	for _, op := range g.pending {
		if op.Op == "del" {
			changes[op.Path] = entry{}
			continue
		}
		if err := checkPath(op.Path); err != nil {
			return nil, err
		}
		e, ok := g.pendingEntries[op.Path]
		if !ok {
			var err error
			e, _, err = snapshot(op.Path, filepath.Join(g.repo, op.Path), "")
			if err != nil {
				return nil, err
			}
		}
		changes[op.Path] = e
	}
	idx := &index{Tree: req.Tree, Entries: []entry{}}
	for _, e := range g.index.Entries {
		if updated, ok := changes[e.Path]; ok {
			delete(changes, e.Path)
			e = updated
		}
		if e.Path != "" {
			idx.Entries = append(idx.Entries, e)
		}
	}
	for _, op := range g.pending {
		if e := changes[op.Path]; e.Path != "" {
			idx.Entries = append(idx.Entries, e)
		}
	}
	if err := g.saveIndex(context.Background(), idx); err != nil {
		return nil, err
	}
	g.pending = nil
	g.pendingEntries = nil
	return message{"entries": len(idx.Entries)}, nil
}
