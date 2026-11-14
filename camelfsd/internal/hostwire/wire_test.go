package hostwire

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
)

func TestUnitHolderEncoding(t *testing.T) {
	for _, boot := range []int64{1, 10, 56801, math.MaxInt64} {
		for _, host := range []string{"i-x", "a._Z", strings.Repeat("h", 64)} {
			for _, mount := range []string{"vm", "9.-_E", strings.Repeat("m", 96)} {
				want := Holder{Host: host, Boot: boot, Mount: mount}
				got, err := ParseHolder(want.String())
				if err != nil || got != want {
					t.Fatalf("%v: %v, %v", want, got, err)
				}
			}
		}
	}
	for _, raw := range []string{"a:b:c:d", "i-x::1", "h:01:v", "h:0:v", "h:-1:v", "h:+1:v", ":1:v", "h:1:",
		strings.Repeat("h", 65) + ":1:v", "h:1:" + strings.Repeat("m", 97), "h:9223372036854775808:v"} {
		if _, err := ParseHolder(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
}

func TestUnitWireJSON(t *testing.T) {
	start := int64(3)
	cases := []struct {
		value any
		want  string
	}{
		{&Register{BootID: "boot", Pool: "p", Addr: "h:8792", Shape: Shape{1, 2, 3}, Slots: 4, Features: []string{"x"}, Images: []string{"img"}},
			`{"bootId":"boot","pool":"p","addr":"h:8792","shape":{"vcpus":1,"memoryMiB":2,"diskMiB":3},"slots":4,"features":["x"],"images":["img"]}`},
		{&Registered{2}, `{"bootEpoch":2}`},
		{&Heartbeat{2, 3, 4, []Running{{"v", &start, true}}}, `{"bootEpoch":2,"at":3,"free":4,"running":[{"id":"v","startedAt":3,"finished":true}]}`},
		{&HeartbeatReply{2, []string{"v"}, []BootSpec{}}, `{"bootEpoch":2,"stop":["v"],"boot":[]}`},
		{&BootSpec{ID: "v", Lineage: "lin", Ref: "main", Version: "c", Tree: "t", Parent: "c", Image: "i",
			Lease: Lease{Holder{"h", 2, "v"}, 5, 6}, Shape: Shape{1, 2, 3}, Internet: true,
			Job: &Job{"true", 8, map[string]string{"a": "b"}, []string{"out"}, true, 10}, Session: &Session{11}, Deadline: 12},
			`{"id":"v","lineage":"lin","ref":"main","version":"c","tree":"t","parent":"c","image":"i","lease":{"holder":{"host":"h","boot":2,"mount":"v"},"epoch":5,"deadline":6},"shape":{"vcpus":1,"memoryMiB":2,"diskMiB":3},"internet":true,"job":{"command":"true","timeoutS":8,"env":{"a":"b"},"outputs":["out"],"commit":true,"pids":10},"session":{"idleStopS":11},"deadline":12}`},
		{&Started{2, 3}, `{"bootEpoch":2,"at":3}`},
		{&Ended{2, 3, "exit", 4, true, "c", "error", "results/lin/v", "sha", 6}, `{"bootEpoch":2,"at":3,"code":"exit","exit":4,"timedOut":true,"version":"c","checkpointError":"error","resultKey":"results/lin/v","resultSha256":"sha","resultBytes":6}`},
		{&Stop{true}, `{"checkpoint":true}`},
	}
	for _, tc := range cases {
		data, err := json.Marshal(tc.value)
		if err != nil || string(data) != tc.want {
			t.Fatalf("%T wire JSON: %s, %v", tc.value, data, err)
		}
		got := reflect.New(reflect.TypeOf(tc.value).Elem()).Interface()
		if err := json.Unmarshal(data, got); err != nil || !reflect.DeepEqual(got, tc.value) {
			t.Fatalf("%T round trip: %+v, %v", tc.value, got, err)
		}
	}
}
