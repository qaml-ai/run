package client

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

func Run(args []string, out io.Writer) error {
	f := flag.NewFlagSet("client", flag.ContinueOnError)
	socket := f.String("socket", "/run/camelfsd/api.sock", "Unix socket")
	if e := f.Parse(args); e != nil {
		return e
	}
	if f.NArg() < 1 {
		return fmt.Errorf("missing client command")
	}
	cmd := f.Arg(0)
	if cmd == "import-tree" || cmd == "tree" || cmd == "cat" {
		return treeCommand(*socket, cmd, f.Args()[1:], out)
	}
	g := flag.NewFlagSet(cmd, flag.ContinueOnError)
	job := g.String("job", "", "job id")
	lineage := g.String("lineage", "", "lineage")
	holder := g.String("holder", "", "runtime fence holder (empty means read-only)")
	epoch := g.Int64("epoch", 0, "runtime fence epoch")
	root := g.String("root", "", "root id")
	tree := g.String("tree", "", "git tree SHA")
	parent := g.String("parent", "", "git parent commit SHA")
	vsock := g.String("vsock", "", "vsock path")
	hydrate := g.Bool("hydrate", true, "hydrate")
	path := g.String("path", "", "import image")
	name := g.String("name", "", "import ref name")
	if e := g.Parse(f.Args()[1:]); e != nil {
		return e
	}
	route := "/v0/mounts/" + url.PathEscape(*job)
	method := "POST"
	var body any = map[string]any{}
	switch cmd {
	case "mount":
		route = "/v0/mounts"
		body = map[string]any{"jobId": *job, "lineage": *lineage, "root": *root, "tree": *tree, "hydrate": *hydrate, "vsock": *vsock, "fence": nil}
		if *parent != "" {
			body.(map[string]any)["parent"] = *parent
		}
		if *holder != "" {
			body.(map[string]any)["fence"] = map[string]any{"holder": *holder, "epoch": *epoch}
		}
	case "checkpoint":
		route += "/checkpoint"
	case "release":
		method = "DELETE"
	case "status":
		method = "GET"
	case "import-image":
		route = "/v0/images"
		body = map[string]any{"lineage": *lineage, "name": *name, "path": *path, "tree": *tree}
	default:
		return fmt.Errorf("unknown client command")
	}
	b, e := json.Marshal(body)
	if e != nil {
		return e
	}
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", *socket)
	}}
	defer tr.CloseIdleConnections()
	c := http.Client{Transport: tr, Timeout: 10 * time.Minute}
	req, e := http.NewRequest(method, "http://camelfsd"+route, bytes.NewReader(b))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := c.Do(req)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	_, e = io.Copy(out, resp.Body)
	if e != nil {
		return e
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
