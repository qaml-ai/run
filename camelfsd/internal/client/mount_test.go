package client_test

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/client"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
)

func TestMountClientSendsExplicitFence(t *testing.T) {
	socket := filepath.Join(testutil.SocketDir(t), "s")
	ln, e := net.Listen("unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	requests := make(chan map[string]json.RawMessage, 2)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Error(e)
			w.WriteHeader(400)
			return
		}
		requests <- body
		w.Write([]byte(`{"ok":true}`))
	})}
	go server.Serve(ln)
	defer server.Close()
	for _, holder := range []string{"", "runtime"} {
		var out bytes.Buffer
		args := []string{"--socket", socket, "mount", "--job", "j", "--lineage", "l", "--tree", strings.Repeat("a", 40), "--holder", holder, "--epoch", "7"}
		parent := strings.Repeat("b", 40)
		if holder != "" {
			args = append(args, "--parent", parent)
		}
		if e := client.Run(args, &out); e != nil {
			t.Fatal(e)
		}
		body := <-requests
		if holder == "" {
			if string(body["fence"]) != "null" {
				t.Fatal("read-only CLI mount must not select legacy mode", string(body["fence"]))
			}
		} else {
			var gotParent string
			if e := json.Unmarshal(body["parent"], &gotParent); e != nil || gotParent != parent {
				t.Fatal(gotParent, e)
			}
			var fence refs.Fence
			if e := json.Unmarshal(body["fence"], &fence); e != nil || fence.Holder != holder || fence.Epoch != 7 {
				t.Fatal(fence, e)
			}
		}
	}
}
