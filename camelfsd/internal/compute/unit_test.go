package compute

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
)

func TestUnitUsageInterval(t *testing.T) {
	v := VM{CreateRequest: CreateRequest{ID: "vm"}, StartedAt: aws.Int64(123), BilledTo: 123, LeaseDeadline: 145456}
	if usageInterval(v, 60122, false) != nil {
		t.Fatal("partial minute was closed")
	}
	if got := usageInterval(v, 200000, false); got.ID != "vm:0" || got.From != 123 || got.To != 60123 || got.Seconds != 60 || got.Final {
		t.Fatalf("whole interval: %+v", got)
	}
	v.BilledTo, v.UsageSeq = 120123, 2
	if got := usageInterval(v, 200000, true); got.To != v.LeaseDeadline || got.Seconds != 25.333 || !got.Final {
		t.Fatalf("lease cutoff: %+v", got)
	}
	v.StopRequestedAt = aws.Int64(130456)
	if usageInterval(v, 200000, false) != nil {
		t.Fatal("billed after stop")
	}
	if got := usageInterval(v, 200000, true); got.ID != "vm:2" || got.To != 130456 || got.Seconds != 10.333 || !got.Final {
		t.Fatalf("stop cutoff: %+v", got)
	}
	if got := usageInterval(v, 120122, true); got.To != v.BilledTo || got.Seconds != 0 || !got.Final {
		t.Fatalf("zero final: %+v", got)
	}
	v.StartedAt = nil
	if usageInterval(v, 200000, true) != nil || usageInterval(v, 200000, false) != nil {
		t.Fatal("unstarted VM emitted usage")
	}
}

func TestUnitRank(t *testing.T) {
	now := int64(100000)
	shape := Shape{VCPUs: 2, MemoryMiB: 1024, DiskGiB: 3}
	host := func(name string, free int) Host {
		return Host{HostInfo: HostInfo{Host: name, Shape: shape}, Free: free, FreeMiB: 1024, LastSeenAt: now}
	}
	hosts := []Host{host("b", 3), host("c", 4), host("a", 3), host("stale", 10),
		host("draining", 10), host("small", 10), host("full", 0), host("no-memory", 10), host("more-memory", 3)}
	hosts[3].LastSeenAt -= hostFreshMS
	hosts[4].Draining = true
	hosts[5].Shape.DiskGiB--
	hosts[7].FreeMiB--
	hosts[8].FreeMiB *= 2
	var names []string
	for _, h := range rank(hosts, shape, now) {
		names = append(names, h.Host)
	}
	if !slices.Equal(names, []string{"c", "more-memory", "a", "b"}) {
		t.Fatal(names)
	}
}

func TestUnitCreateMatch(t *testing.T) {
	req := CreateRequest{ID: "vm", Lineage: "lineage", Ref: "main", Mode: JobMode, Payer: "payer"}
	v := VM{CreateRequest: req}
	for _, mutate := range []func(*CreateRequest){
		func(r *CreateRequest) { r.Lineage = "other" }, func(r *CreateRequest) { r.Ref = "other" },
		func(r *CreateRequest) { r.Mode = SessionMode }, func(r *CreateRequest) { r.Payer = "other" },
	} {
		copy := req
		mutate(&copy)
		if matches(v, copy) {
			t.Fatal("matched another request")
		}
	}
	req.Deadline = time.Now()
	req.Image = "other"
	if !matches(v, req) {
		t.Fatal("failed to match replay")
	}
}

func TestUnitULID(t *testing.T) {
	at := time.UnixMilli(1469918176385)
	a, err := mintULID(at)
	if err != nil {
		t.Fatal(err)
	}
	same, err := mintULID(at)
	if err != nil || a >= same {
		t.Fatalf("same millisecond ULIDs: %s, %s (%v)", a, same, err)
	}
	b, err := mintULID(at.Add(time.Millisecond))
	if err != nil || !ulidPattern.MatchString(a) || !ulidPattern.MatchString(b) || a[:10] != "01ARYZ6S41" || a >= b {
		t.Fatalf("ULIDs: %s, %s (%v)", a, b, err)
	}
}

// Scan expression literals, including fragments concatenated at runtime.
func TestUnitExpressionNames(t *testing.T) {
	files, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	word := regexp.MustCompile(`[#:]*[A-Za-z][A-Za-z0-9_]*`)
	keywords := strings.Fields("AND OR NOT IN BETWEEN SET ADD DELETE REMOVE attribute_exists attribute_not_exists contains size begins_with if_not_exists")
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".go") || strings.HasSuffix(file.Name(), "_test.go") {
			continue
		}
		fset := token.NewFileSet()
		tree, err := parser.ParseFile(fset, file.Name(), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(tree, func(node ast.Node) bool {
			lit, ok := node.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			expr, _ := strconv.Unquote(lit.Value)
			if !strings.ContainsAny(expr, "=<>#()") || strings.HasPrefix(expr, waitPrefix) || expr == releasePrefix || expr == aliasPattern.String() {
				return true
			}
			for _, token := range word.FindAllString(expr, -1) {
				if strings.HasPrefix(token, "#") || strings.HasPrefix(token, ":") || slices.Contains(keywords, token) {
					continue
				}
				t.Errorf("%s: bare expression identifier %q in %q", fset.Position(lit.Pos()), token, expr)
			}
			return true
		})
	}
}

func TestUnitRankPrefersImageAfterFit(t *testing.T) {
	shape := Shape{VCPUs: 2, MemoryMiB: 1024, DiskMiB: 128}
	warm := Host{HostInfo: HostInfo{Host: "warm", Shape: shape, Images: []string{"image"}}, LastSeenAt: 1, Free: 1, FreeMiB: 1024}
	cold := Host{HostInfo: HostInfo{Host: "cold", Shape: shape}, LastSeenAt: 1, Free: 10, FreeMiB: 10240}
	noFit := warm
	noFit.Host = "no-fit"
	noFit.FreeMiB--
	got := rankImage([]Host{cold, noFit, warm}, shape, 0, "image")
	if len(got) != 2 || got[0].Host != "warm" || got[1].Host != "cold" {
		t.Fatal(got)
	}
}
