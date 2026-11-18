// Guest endpoint used by the private persistent-disk prototype.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"strings"
	"syscall"
)

type request struct {
	Op      string `json:"op"`
	Path    string `json:"path"`
	Data    []byte `json:"data"`
	Command string `json:"command"`
}

type response struct {
	Data   []byte `json:"data,omitempty"`
	Stderr []byte `json:"stderr,omitempty"`
	Status int    `json:"status"`
	Error  string `json:"error,omitempty"`
}

func workspaceFile(q request) ([]byte, error) {
	if !fs.ValidPath(q.Path) || q.Path == "." {
		return nil, errors.New("invalid workspace-relative path")
	}
	dir, err := os.Open("/workspace")
	if err != nil {
		return nil, err
	}
	defer func() { dir.Close() }()
	parts := strings.Split(q.Path, "/")
	for _, name := range parts[:len(parts)-1] {
		fd := int(dir.Fd())
		next, err := syscall.Openat(fd, name, syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_RDONLY, 0)
		if errors.Is(err, syscall.ENOENT) && q.Op == "put" {
			if err = syscall.Mkdirat(fd, name, 0755); err != nil && !errors.Is(err, syscall.EEXIST) {
				return nil, err
			}
			next, err = syscall.Openat(fd, name, syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_RDONLY, 0)
		}
		if err != nil {
			return nil, err
		}
		dir.Close()
		dir = os.NewFile(uintptr(next), name)
	}
	flags := syscall.O_NONBLOCK | syscall.O_NOFOLLOW
	if q.Op == "put" {
		flags |= syscall.O_CREAT | syscall.O_WRONLY
	}
	fd, err := syscall.Openat(int(dir.Fd()), path.Base(q.Path), flags, 0644)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), q.Path)
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("expected regular file")
	}
	if q.Op == "get" {
		return io.ReadAll(f)
	}
	if st.Sys().(*syscall.Stat_t).Nlink != 1 {
		return nil, errors.New("refusing multiply linked file")
	}
	if err := f.Truncate(0); err != nil {
		return nil, err
	}
	_, err = f.Write(q.Data)
	return nil, err
}

func serve(q request) (r response, err error) {
	switch q.Op {
	case "get", "put":
		r.Data, err = workspaceFile(q)
	case "exec":
		cmd := exec.Command("/bin/bash", "-c", q.Command)
		cmd.Dir = "/workspace"
		var out, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &stderr
		err = cmd.Run()
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			r.Status, err = exit.ExitCode(), nil
		}
		r.Data, r.Stderr = out.Bytes(), stderr.Bytes()
	default:
		err = fmt.Errorf("unknown operation %q", q.Op)
	}
	return r, err
}

func main() {
	var q request
	r := response{}
	err := json.NewDecoder(os.Stdin).Decode(&q)
	if err == nil {
		r, err = serve(q)
	}
	if err != nil {
		r.Error = err.Error()
	}
	if err := json.NewEncoder(os.Stdout).Encode(r); err != nil {
		os.Exit(1)
	}
}
