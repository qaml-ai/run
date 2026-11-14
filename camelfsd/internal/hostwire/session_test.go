package hostwire

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestSessionWireJSON(t *testing.T) {
	stdin := "input\n"
	at := int64(88)
	for _, tc := range []struct {
		value any
		want  string
	}{
		{ShellCreated{"sh"}, `{"shellId":"sh"}`},
		{ExecRequest{ExecID: "e", Command: "echo ok", TimeoutS: 120}, `{"execId":"e","command":"echo ok","timeoutS":120}`},
		{ExecRequest{"e", "cat", "sh", "/workspace", 120, map[string]string{"A": "1"}, &stdin},
			`{"execId":"e","command":"cat","shell":"sh","cwd":"/workspace","timeoutS":120,"env":{"A":"1"},"stdin":"input\n"}`},
		{ExecChunk{[]byte("abc"), 2}, `{"data":"YWJj","offset":2}`},
		{ExecExit{Code: 1, TimedOut: true, MS: 123}, `{"code":1,"timedOut":true,"ms":123}`},
		{ExecExit{MS: 1, Truncated: true}, `{"code":0,"timedOut":false,"ms":1,"truncated":true}`},
		{CheckpointRequest{"save", json.RawMessage(`{"kind":"manual"}`), &at}, `{"message":"save","trailers":{"kind":"manual"},"time":88}`},
		{CheckpointReply{"v", "t", json.RawMessage(`[]`), true}, `{"version":"v","tree":"t","diff":[],"changed":true}`},
		{CheckpointReply{"v", "t", json.RawMessage(`[]`), false}, `{"version":"v","tree":"t","diff":[],"changed":false}`},
	} {
		raw, err := json.Marshal(tc.value)
		if err != nil || string(raw) != tc.want {
			t.Fatalf("%T: got %s, %v, want %s", tc.value, raw, err, tc.want)
		}
		out := reflect.New(reflect.TypeOf(tc.value))
		if err := json.Unmarshal([]byte(tc.want), out.Interface()); err != nil || !reflect.DeepEqual(out.Elem().Interface(), tc.value) {
			t.Fatalf("%T: decoded %+v, %v", tc.value, out.Elem(), err)
		}
	}
}
