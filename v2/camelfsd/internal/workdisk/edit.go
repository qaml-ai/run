package workdisk

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

type Edit struct {
	Path   string
	Data   []byte
	Mode   int
	Delete bool
}

// Apply gives the editor a private view. Only a successful editor exit can
// publish a map. No process mounts the image on the API host.
func (d *Disks) Apply(ctx context.Context, lineage, root string, edits []Edit) (string, error) {
	if len(edits) == 0 {
		return root, nil
	}
	view, err := d.Open(ctx, root)
	if err != nil {
		return "", err
	}
	defer view.Close()
	dir, err := os.MkdirTemp(d.scratch, "ext4-edit-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	plan, err := os.Create(filepath.Join(dir, "plan"))
	if err != nil {
		return "", err
	}
	for i, edit := range edits {
		op := byte('D')
		if !edit.Delete {
			op = 'W'
			if err = os.WriteFile(filepath.Join(dir, fmt.Sprint(i)), edit.Data, 0600); err != nil {
				_ = plan.Close()
				return "", err
			}
		}
		mode := uint32(edit.Mode & 0777)
		if _, err := fmt.Fprintf(plan, "%c%04o%s%c", op, mode, edit.Path, 0); err != nil {
			_ = plan.Close()
			return "", err
		}
	}
	if err := plan.Close(); err != nil {
		return "", err
	}
	cmd := exec.CommandContext(ctx, d.editor)
	cmd.Dir = dir
	cmd.Stderr = os.Stderr
	toEditor, err := cmd.StdinPipe()
	if err != nil {
		return "", err
	}
	fromEditor, err := cmd.StdoutPipe()
	if err != nil {
		_ = toEditor.Close()
		return "", err
	}
	if err := cmd.Start(); err != nil {
		_ = toEditor.Close()
		_ = fromEditor.Close()
		return "", err
	}
	err = serveEditor(ctx, bufio.NewReader(fromEditor), toEditor, view)
	_ = toEditor.Close()
	if err != nil {
		_ = cmd.Process.Kill()
	}
	if err = errors.Join(err, cmd.Wait()); err != nil {
		return "", fmt.Errorf("edit ext4 workspace: %w", err)
	}
	return d.save(ctx, lineage, view)
}

func serveEditor(ctx context.Context, in *bufio.Reader, out io.Writer, view *View) error {
	var hdr [17]byte
	for {
		if _, err := io.ReadFull(in, hdr[:]); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		size := binary.LittleEndian.Uint64(hdr[9:])
		offset := int64(binary.LittleEndian.Uint64(hdr[1:]))
		if (hdr[0] != 'R' && hdr[0] != 'W') || offset < 0 || offset > view.Size() || size > uint64(view.Size()-offset) {
			return fmt.Errorf("invalid ext4 editor request")
		}
		// Transfer in chunk-sized pieces, including when libext2fs requests a whole bitmap.
		buf := make([]byte, min(size, ChunkSize))
		for remaining := size; remaining > 0; {
			n := min(uint64(len(buf)), remaining)
			write := hdr[0] == 'W'
			if write {
				if _, err := io.ReadFull(in, buf[:n]); err != nil {
					return err
				}
			}
			if err := view.Transfer(ctx, write, offset, buf[:n]); err != nil {
				return err
			}
			if !write {
				if _, err := out.Write(buf[:n]); err != nil {
					return err
				}
			}
			offset += int64(n)
			remaining -= n
		}
	}
}
