package refstore

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
)

const lineage = "tenant:repo"

func id(n int) string { return fmt.Sprintf("%040x", n) }

type commitFunc func(context.Context, string, string) ([]string, bool, error)

func (f commitFunc) Parents(ctx context.Context, lineage, id string) ([]string, bool, error) {
	return f(ctx, lineage, id)
}

func localStore(t *testing.T, commits Commits) (*Store, *time.Time) {
	t.Helper()
	client, table := ddbtest.Table(t, ddbtest.Schema{
		Keys: []types.KeySchemaElement{
			{AttributeName: aws.String("lineage"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("name"), KeyType: types.KeyTypeRange},
		},
		Attributes: []types.AttributeDefinition{
			{AttributeName: aws.String("lineage"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("name"), AttributeType: types.ScalarAttributeTypeS},
		},
	})
	now := time.Unix(1700000000, 0)
	return New(client, table, func() time.Time { return now }, commits), &now
}

func wantError(t *testing.T, err error, code string, status int) *Error {
	t.Helper()
	var got *Error
	if !errors.As(err, &got) || got.Code != code || got.Status != status {
		t.Fatalf("error = %v, want %s (%d)", err, code, status)
	}
	return got
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestCasRules(t *testing.T) {
	base, child, other, merge, missing, deadEnd := id(1), id(2), id(3), id(4), id(5), id(6)
	graph := map[string][]string{
		child: {base}, other: {}, merge: {missing, child}, deadEnd: {missing},
	}
	s, _ := localStore(t, commitFunc(func(_ context.Context, l, v string) ([]string, bool, error) {
		if l != lineage || v == base {
			return nil, false, fmt.Errorf("unexpected commit read %s/%s", l, v)
		}
		parents, ok := graph[v]
		return parents, ok, nil
	}))
	ctx := t.Context()
	for i, tc := range []struct {
		name               string
		move               Move
		absent, held, noOp bool
		code               string
		status             int
		details            map[string]any
	}{
		{name: "child", move: Move{Kind: "commit", Version: child, Parents: []string{base}}},
		{name: "merge commit", move: Move{Kind: "commit", Version: merge, Parents: []string{base, other}}},
		{name: "reverse merge", move: Move{Kind: "commit", Version: merge, Parents: []string{other, base}}, code: "bad_parent", status: 409, details: map[string]any{"current": base, "parents": []string{other, base}}},
		{name: "no parent", move: Move{Kind: "commit", Version: child}, code: "bad_parent", status: 409},
		{name: "too many parents", move: Move{Kind: "commit", Version: child, Parents: []string{base, other, merge}}, code: "bad_parent", status: 409},
		{name: "pre-fork base", move: Move{Kind: "move", Version: child}},
		{name: "merge second parent and dead end", move: Move{Kind: "move", Version: merge}},
		{name: "dead end only", move: Move{Kind: "move", Version: deadEnd}, code: "not_fast_forward", status: 409},
		{name: "unrelated", move: Move{Kind: "move", Version: other}, code: "not_fast_forward", status: 409},
		{name: "unknown target", move: Move{Kind: "move", Version: missing}, code: "unknown_commit", status: 400},
		{name: "noop", move: Move{Kind: "move", Version: base}, noOp: true},
		{name: "absent move", move: Move{Kind: "move", Version: missing, ExpectAbsent: true}, absent: true},
		{name: "absent commit", move: Move{Kind: "commit", Version: child}, absent: true},
		{name: "expect mismatch precedes fence", move: Move{Kind: "move", Version: base, Expect: &other}, held: true, code: "stale", status: 412, details: map[string]any{"current": base}},
		{name: "expected absent", move: Move{Kind: "move", Version: base, ExpectAbsent: true}, code: "stale", status: 412, details: map[string]any{"current": base}},
		{name: "expect missing", move: Move{Kind: "move", Version: child, Expect: &base}, absent: true, code: "stale", status: 412, details: map[string]any{"current": nil}},
		{name: "held no fence", move: Move{Kind: "move", Version: base}, held: true, code: "fenced", status: 409},
		{name: "wrong epoch", move: Move{Kind: "move", Version: base, Fence: &Fence{"holder", 2}}, held: true, code: "fenced", status: 409},
		{name: "wrong holder", move: Move{Kind: "move", Version: base, Fence: &Fence{"other", 1}}, held: true, code: "fenced", status: 409},
		{name: "spurious fence", move: Move{Kind: "move", Version: base, Fence: &Fence{"holder", 1}}, code: "fenced", status: 409},
		{name: "absent fenced", move: Move{Kind: "move", Version: child, Fence: &Fence{"holder", 1}}, absent: true, code: "fenced", status: 409},
		{name: "valid fence", move: Move{Kind: "move", Version: child, Fence: &Fence{"holder", 1}}, held: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			name := fmt.Sprintf("ref-%02d", i)
			if !tc.absent {
				must(t, s.Create(ctx, lineage, name, Target{Version: base, Tree: id(9)}, nil, nil))
				must(t, s.Watch(ctx, lineage, name, "agent:a"))
			}
			if tc.held {
				_, err := s.Acquire(ctx, lineage, name, "holder", 1000)
				must(t, err)
			}
			tc.move.Tree = id(10)
			result, err := s.Cas(ctx, lineage, name, tc.move)
			if tc.code != "" {
				got := wantError(t, err, tc.code, tc.status)
				if tc.details != nil && !reflect.DeepEqual(got.Details, tc.details) {
					t.Fatalf("details = %v, want %v", got.Details, tc.details)
				}
				return
			}
			must(t, err)
			if result.Version != tc.move.Version || result.NoOp != tc.noOp ||
				(tc.absent && result.Previous != nil) || (!tc.absent && aws.ToString(result.Previous) != base) {
				t.Fatalf("result = %+v", result)
			}
			if !tc.absent && !reflect.DeepEqual(result.Watchers, []string{"agent:a"}) {
				t.Fatalf("watchers = %v", result.Watchers)
			}
			ref, err := s.Get(ctx, lineage, name)
			must(t, err)
			wantTree := tc.move.Tree
			if tc.noOp {
				wantTree = id(9)
			}
			if ref.Version != tc.move.Version || ref.Tree != wantTree {
				t.Fatalf("ref = %+v", ref)
			}
		})
	}
}

func TestCasAncestryLimit(t *testing.T) {
	var reads int
	s, _ := localStore(t, commitFunc(func(_ context.Context, _, v string) ([]string, bool, error) {
		reads++
		n, err := strconv.ParseInt(v, 16, 32)
		return []string{id(int(n + 1))}, true, err
	}))
	ctx := t.Context()
	for _, n := range []int{50000, 50001} {
		t.Run(strconv.Itoa(n), func(t *testing.T) {
			reads = 0
			name := fmt.Sprintf("limit/%d", n)
			must(t, s.Create(ctx, lineage, name, Target{Version: id(n), Tree: id(9)}, nil, nil))
			_, err := s.Cas(ctx, lineage, name, Move{Kind: "move", Version: id(1), Tree: id(9)})
			if n == 50000 {
				must(t, err)
			} else {
				got := wantError(t, err, "not_fast_forward", 409)
				if got.Details["reason"] != "too_deep" {
					t.Fatalf("details = %v", got.Details)
				}
			}
			if reads != min(n-1, 50000) {
				t.Fatalf("commit reads = %d", reads)
			}
		})
	}
}

func race(n int, fn func(int)) {
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			fn(i)
		}()
	}
	close(start)
	wg.Wait()
}

func TestCasRace(t *testing.T) {
	s, _ := localStore(t, nil)
	ctx := t.Context()
	base := id(1)
	must(t, s.Create(ctx, lineage, "main", Target{Version: base, Tree: id(9)}, nil, nil))
	var results [32]Result
	var errs [32]error
	race(len(errs), func(i int) {
		results[i], errs[i] = s.Cas(ctx, lineage, "main", Move{
			Kind: "commit", Version: id(i + 2), Tree: id(9), Expect: &base, Parents: []string{base},
		})
	})
	winner := ""
	for i, err := range errs {
		if err == nil {
			if winner != "" {
				t.Fatal("multiple CAS winners")
			}
			winner = results[i].Version
		}
	}
	if winner == "" {
		t.Fatalf("no CAS winner: %v", errs)
	}
	for _, err := range errs {
		if err != nil {
			got := wantError(t, err, "stale", 412)
			if got.Details["current"] != winner {
				t.Fatalf("stale current = %v, winner %s", got.Details, winner)
			}
		}
	}
}

func TestAcquireRace(t *testing.T) {
	s, now := localStore(t, nil)
	ctx := t.Context()
	base := id(1)
	must(t, s.Create(ctx, lineage, "main", Target{Version: base, Tree: id(9)}, nil, nil))
	var leases [16]Lease
	var errs [16]error
	holder := func(i int) string { return fmt.Sprintf("holder-%d", i) }
	race(len(errs), func(i int) {
		leases[i], errs[i] = s.Acquire(ctx, lineage, "main", holder(i), 1000)
	})
	var fence Fence
	for i, err := range errs {
		if err != nil {
			wantError(t, err, "held", 409)
			continue
		}
		if fence.Holder != "" || leases[i].Epoch != 1 {
			t.Fatalf("unexpected winner: %d, %+v", i, leases[i])
		}
		fence = Fence{holder(i), leases[i].Epoch}
	}
	if fence.Holder == "" {
		t.Fatal("no lease winner")
	}
	same, err := s.Acquire(ctx, lineage, "main", fence.Holder, 2000)
	must(t, err)
	if same.Epoch != fence.Epoch || same.Deadline != now.UnixMilli()+2000 {
		t.Fatalf("same-holder acquisition = %+v", same)
	}
	_, err = s.Acquire(ctx, lineage, "main", "other", 1000)
	wantError(t, err, "held", 409)
	*now = time.UnixMilli(same.Deadline)
	next, err := s.Acquire(ctx, lineage, "main", "takeover", 1000)
	must(t, err)
	if next.Epoch != fence.Epoch+1 {
		t.Fatalf("takeover = %+v after %+v", next, same)
	}
	_, err = s.Cas(ctx, lineage, "main", Move{Kind: "commit", Version: id(2), Tree: id(9), Parents: []string{base}, Fence: &fence})
	wantError(t, err, "fenced", 409)
	_, err = s.Renew(ctx, lineage, "main", fence, 1000)
	wantError(t, err, "fenced", 409)
	wantError(t, s.Release(ctx, lineage, "main", fence), "fenced", 409)
	current := Fence{"takeover", next.Epoch}
	renewed, err := s.Renew(ctx, lineage, "main", current, 2000)
	must(t, err)
	if renewed.Epoch != next.Epoch || renewed.Deadline != now.UnixMilli()+2000 {
		t.Fatalf("renew = %+v", renewed)
	}
	must(t, s.Release(ctx, lineage, "main", current))
}

func TestExpiryAndCleanup(t *testing.T) {
	s, now := localStore(t, nil)
	ctx := t.Context()
	target := Target{Version: id(1), Tree: id(9)}
	owner := "job:one"
	expires := now.UnixMilli() + 500
	for _, name := range []string{"job/expired", "job/held", "job/sweep", "job/cas"} {
		must(t, s.Create(ctx, lineage, name, target, &owner, &expires))
		lease, err := s.Acquire(ctx, lineage, name, "holder", 1000)
		must(t, err)
		if name != "job/held" {
			must(t, s.Release(ctx, lineage, name, Fence{"holder", lease.Epoch}))
		}
		must(t, s.Watch(ctx, lineage, name, "agent:old"))
	}
	must(t, s.Create(ctx, lineage, "job/owned", target, &owner, nil))
	must(t, s.Create(ctx, lineage, "unrelated", target, nil, nil))
	*now = time.UnixMilli(expires)
	_, err := s.Get(ctx, lineage, "job/expired")
	wantError(t, err, "no_ref", 404)
	wantError(t, s.Watch(ctx, lineage, "job/expired", "agent:a"), "no_ref", 404)
	wantError(t, s.Unwatch(ctx, lineage, "job/expired", "agent:old"), "no_ref", 404)
	wantError(t, s.Delete(ctx, lineage, "job/held", nil), "held", 409)
	wantError(t, s.Create(ctx, lineage, "job/held", target, nil, nil), "exists", 409)

	refs, next, err := s.List(ctx, lineage, "job/", "", 1)
	must(t, err)
	if len(refs) != 1 || refs[0].Name != "job/held" || next != "job/held" {
		t.Fatalf("first page = %+v, next %q", refs, next)
	}
	refs, next, err = s.List(ctx, lineage, "job/", next, 1)
	must(t, err)
	if len(refs) != 1 || refs[0].Name != "job/owned" || next != "" {
		t.Fatalf("second page = %+v, next %q", refs, next)
	}
	deleted, held, err := s.DeleteOwned(ctx, lineage, owner)
	must(t, err)
	if !reflect.DeepEqual(deleted, []string{"job/owned"}) || !reflect.DeepEqual(held, []string{"job/held"}) {
		t.Fatalf("DeleteOwned deleted %v, held %v", deleted, held)
	}

	must(t, s.Create(ctx, lineage, "job/expired", target, nil, nil))
	result, err := s.Cas(ctx, lineage, "job/cas", Move{Kind: "move", Version: id(2), Tree: id(9), ExpectAbsent: true})
	must(t, err)
	if result.Previous != nil || len(result.Watchers) != 0 {
		t.Fatalf("expired CAS = %+v", result)
	}
	must(t, s.SweepExpired(ctx, lineage))
	_, err = s.Get(ctx, lineage, "job/sweep")
	wantError(t, err, "no_ref", 404)
	must(t, s.Create(ctx, lineage, "job/sweep", target, nil, nil))
	_, err = s.Get(ctx, lineage, "job/held")
	must(t, err)

	for _, name := range []string{"job/expired", "job/sweep", "job/cas"} {
		ref, err := s.Get(ctx, lineage, name)
		must(t, err)
		if ref.LeaseEpoch != 1 || len(ref.Watchers) != 0 || ref.ExpiresAt != nil || ref.Owner != nil || ref.Holder != nil {
			t.Fatalf("recreated ref = %+v", ref)
		}
		must(t, s.Delete(ctx, lineage, name, &ref.Version))
		must(t, s.Create(ctx, lineage, name, target, nil, nil))
		lease, err := s.Acquire(ctx, lineage, name, "holder", 1000)
		must(t, err)
		if lease.Epoch != 2 {
			t.Fatalf("lease after delete and create = %+v", lease)
		}
		wantError(t, s.Release(ctx, lineage, name, Fence{"holder", 1}), "fenced", 409)
	}
}

type retryClient struct {
	Client
	versions      []string
	failures      int
	reads, writes int
}

func (c *retryClient) GetItem(_ context.Context, in *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	version := c.versions[c.reads]
	c.reads++
	if !aws.ToBool(in.ConsistentRead) {
		return nil, errors.New("expected a strongly consistent read")
	}
	return &dynamodb.GetItemOutput{Item: attributes{"version": str(version)}}, nil
}

func (c *retryClient) UpdateItem(_ context.Context, in *dynamodb.UpdateItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	c.writes++
	want := c.versions[c.reads-1]
	if !reflect.DeepEqual(in.ExpressionAttributeValues[":current"], str(want)) {
		return nil, fmt.Errorf("write %d did not pin %s", c.writes, want)
	}
	if c.writes <= c.failures {
		return nil, &types.ConditionalCheckFailedException{}
	}
	return &dynamodb.UpdateItemOutput{}, nil
}

func TestCasConditionFailure(t *testing.T) {
	base, child, other := id(1), id(2), id(3)
	for _, tc := range []struct {
		name             string
		versions         []string
		failures, writes int
		staleCurrent     string
	}{
		{"retry succeeds", []string{base, base}, 1, 2, ""},
		{"retry sees competing version", []string{base, other}, 1, 1, other},
		{"second failure reports latest", []string{base, base, other}, 2, 2, other},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &retryClient{versions: tc.versions, failures: tc.failures}
			s := New(client, "test", nil, nil)
			result, err := s.Cas(t.Context(), lineage, "main", Move{
				Kind: "commit", Version: child, Tree: id(9), Expect: &base, Parents: []string{base},
			})
			if tc.staleCurrent == "" {
				must(t, err)
				if result.Version != child || aws.ToString(result.Previous) != base {
					t.Fatalf("result = %+v", result)
				}
			} else if got := wantError(t, err, "stale", 412); got.Details["current"] != tc.staleCurrent {
				t.Fatalf("details = %v", got.Details)
			}
			if client.reads != len(tc.versions) || client.writes != tc.writes {
				t.Fatalf("reads = %d, writes = %d", client.reads, client.writes)
			}
		})
	}
}
