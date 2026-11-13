package compute

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/delivery"
)

const intervalMS = int64(60_000)

type UsageShape struct {
	VCPUs     int `json:"vcpus"`
	MemoryMiB int `json:"memoryMiB"`
}

// MONEY: ID is the runtime's dedupe key. ULID is only the ledger's ordering key.
type UsageEvent struct {
	ID      string     `json:"id"`
	Type    string     `json:"type"`
	VM      string     `json:"vm"`
	Payer   string     `json:"payer"`
	Pool    string     `json:"pool"`
	Shape   UsageShape `json:"shape"`
	Host    string     `json:"host"`
	From    int64      `json:"from"`
	To      int64      `json:"to"`
	Seconds float64    `json:"seconds"`
	Final   bool       `json:"final"`
}

// MONEY: Only host-reported runtime is billable, bounded by stop and lease.
func usageThrough(v VM, at int64) int64 {
	at = min(at, v.LeaseDeadline)
	if v.StopRequestedAt != nil {
		at = min(at, *v.StopRequestedAt)
	}
	return at
}

func usageInterval(v VM, at int64, final bool) *UsageEvent {
	if v.StartedAt == nil {
		return nil
	}
	to := usageThrough(v, at)
	if final {
		to = max(to, v.BilledTo)
	} else {
		// Close at most one complete interval per heartbeat.
		if to-v.BilledTo < intervalMS {
			return nil
		}
		to = v.BilledTo + intervalMS
	}
	return &UsageEvent{
		ID: fmt.Sprintf("%s:%d", v.ID, v.UsageSeq), Type: "usage.vm", VM: v.ID,
		Payer: v.Payer, Pool: v.Pool, Shape: UsageShape{VCPUs: v.Shape.VCPUs, MemoryMiB: v.Shape.MemoryMiB},
		Host: v.Host, From: v.BilledTo, To: to, Seconds: float64(to-v.BilledTo) / 1000, Final: final,
	}
}

const usageCAS = "#usageSeq = :seq AND #billedTo = :from"

func (c *Controller) ExtendUsage(ctx context.Context, id string, upTo time.Time) (VM, error) {
	v, err := c.Get(ctx, id)
	if err != nil || (v.Phase != Running && v.Phase != Stopping) {
		return v, err
	}
	event := usageInterval(v, upTo.UnixMilli(), false)
	if event == nil {
		return v, nil
	}
	// MONEY: Commit the ledger row and advance both billing fields atomically.
	// The exact phase also fences a stop that could have changed the cutoff.
	vm := change(c.Tables.VMs, vmKey(id), "#phase = :phase AND #leaseDeadline = :lease AND "+usageCAS,
		"SET #billedTo = :to, #usageSeq = :next",
		attrs{":phase": s(string(v.Phase)), ":lease": n(v.LeaseDeadline), ":seq": n(v.UsageSeq),
			":from": n(v.BilledTo), ":to": n(event.To), ":next": n(v.UsageSeq + 1)})
	if err := c.writeWithUsage(ctx, event, v.UsageSeq, types.TransactWriteItem{Update: vm}); err != nil {
		return VM{}, err
	}
	v.BilledTo = event.To
	v.UsageSeq++
	return v, nil
}

func (c *Controller) writeWithUsage(ctx context.Context, event *UsageEvent, seq int64, writes ...types.TransactWriteItem) error {
	if event == nil {
		return c.transact(ctx, writes...)
	}
	body, err := json.Marshal(event)
	if err != nil {
		return err
	}

	// MONEY: Mint a fresh ULID for each attempt immediately before the write.
	// GET /v1/usage uses a watermark of now minus two heartbeats (20s), which
	// relies on the ULID time being within 5s of commit. The 5s deadline
	// covers the entire call, including any SDK retries.
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	now := c.now()
	id, err := mintULID(now)
	if err != nil {
		return err
	}
	row := attrs{
		"shard": s(delivery.Shard(event.VM)), "ulid": s(id), "eventId": s(event.ID),
		"body": s(string(body)), "vm": s(event.VM), "seq": n(seq),
		"expiresAt": n(now.Add(35 * 24 * time.Hour).Unix()),
	}
	return c.transact(ctx, append(writes, put(c.Tables.Usage, row, "attribute_not_exists(#ulid)"))...)
}

const ulidAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const maxULIDTime = (1 << 48) - 1

// usageIDs orders IDs minted in the same millisecond. Its random seed
// keeps different controller processes independent.
var usageIDs struct {
	sync.Mutex
	ms      int64
	entropy [10]byte
	valid   bool
}

func mintULID(now time.Time) (string, error) {
	ms := now.UnixMilli()
	if ms < 0 || ms > maxULIDTime {
		return "", ErrInvalid
	}
	usageIDs.Lock()
	defer usageIDs.Unlock()
	if usageIDs.valid && usageIDs.ms == ms {
		for i := len(usageIDs.entropy) - 1; i >= 0; i-- {
			usageIDs.entropy[i]++
			if usageIDs.entropy[i] != 0 {
				break
			}
		}
	} else {
		if _, err := rand.Read(usageIDs.entropy[:]); err != nil {
			return "", err
		}
		usageIDs.ms, usageIDs.valid = ms, true
	}
	var id [26]byte
	copy(id[:10], ulidPrefix(ms))
	var bits uint32
	var count uint
	index := 10
	for _, value := range usageIDs.entropy {
		bits = bits<<8 | uint32(value)
		count += 8
		for count >= 5 {
			count -= 5
			id[index] = ulidAlphabet[(bits>>count)&31]
			index++
		}
	}
	return string(id[:]), nil
}

func ulidPrefix(ms int64) string {
	var prefix [10]byte
	for i := len(prefix) - 1; i >= 0; i-- {
		prefix[i] = ulidAlphabet[ms&31]
		ms >>= 5
	}
	return string(prefix[:])
}

type usageCursor [delivery.Shards]string

var ulidPattern = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

func decodeCursor(cursor string) (usageCursor, error) {
	var result usageCursor
	if cursor == "" {
		return result, nil
	}
	body, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return result, ErrInvalid
	}
	var keys []string
	if err := json.Unmarshal(body, &keys); err != nil || len(keys) != len(result) {
		return result, ErrInvalid
	}
	for _, key := range keys {
		if key != "" && !ulidPattern.MatchString(key) {
			return result, ErrInvalid
		}
	}
	copy(result[:], keys)
	return result, nil
}

// ListUsage reads shards in numeric order and each shard in ULID order. A
// cursor advances only for rows returned, so it can also be used on the next
// poll with a newer watermark. The caller supplies a settled watermark (see writeWithUsage).
func (c *Controller) ListUsage(ctx context.Context, cursor string, limit int, watermark time.Time) ([]UsageEvent, string, error) {
	keys, err := decodeCursor(cursor)
	if err != nil || limit <= 0 {
		return nil, "", ErrInvalid
	}
	lastMS := watermark.Add(-time.Nanosecond).UnixMilli()
	if lastMS < 0 {
		return nil, cursor, nil
	}
	upper := ulidPrefix(min(lastMS, maxULIDTime)) + "ZZZZZZZZZZZZZZZZ"
	var events []UsageEvent
	for shard, key := range keys {
		lower := key + "0" // Lexicographically after key, before any greater fixed-length ULID.
		if lower > upper {
			continue
		}
		const cond = "#shard = :shard AND #ulid BETWEEN :lower AND :upper"
		pages := dynamodb.NewQueryPaginator(c.DB, &dynamodb.QueryInput{
			TableName: aws.String(c.Tables.Usage), ConsistentRead: aws.Bool(true),
			KeyConditionExpression: aws.String(cond), ExpressionAttributeNames: aliases(cond),
			ExpressionAttributeValues: attrs{":shard": s(strconv.Itoa(shard)), ":lower": s(lower), ":upper": s(upper)},
			Limit:                     aws.Int32(int32(min(limit-len(events), 1<<31-1))),
		})
		for pages.HasMorePages() && len(events) < limit {
			page, err := pages.NextPage(ctx)
			if err != nil {
				return nil, "", err
			}
			for _, i := range page.Items {
				row := item(i)
				var event UsageEvent
				if err := json.Unmarshal([]byte(row.text("body")), &event); err != nil {
					return nil, "", err
				}
				events = append(events, event)
				keys[shard] = row.text("ulid")
				if len(events) == limit {
					break
				}
			}
		}
		if len(events) == limit {
			break
		}
	}
	if len(events) == 0 {
		return events, cursor, nil
	}
	body, err := json.Marshal(keys)
	if err != nil {
		return nil, "", err
	}
	return events, base64.RawURLEncoding.EncodeToString(body), nil
}
