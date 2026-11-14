package compute

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

type clockTransport func(*http.Request) (*http.Response, error)

func (fn clockTransport) Do(r *http.Request) (*http.Response, error) { return fn(r) }

func TestUnitClockSkewListed(t *testing.T) {
	now := time.Now()
	start := now.Add(-65 * time.Second).UnixMilli()
	billedTo, lastListed := start, int64(0)
	offset := 10 * time.Second
	var transactions, warnings int
	client := dynamodb.New(dynamodb.Options{
		Region: "us-east-1", Credentials: credentials.NewStaticCredentialsProvider("test", "test", ""),
		HTTPClient: clockTransport(func(r *http.Request) (*http.Response, error) {
			switch r.Header.Get("X-Amz-Target") {
			case "DynamoDB_20120810.UpdateItem":
				lastListed = now.UnixMilli()
			case "DynamoDB_20120810.TransactWriteItems":
				transactions++
				billedTo += intervalMS
			}
			row, _ := json.Marshal(map[string]map[string]string{
				"id": {"S": "vm"}, "phase": {"S": "running"}, "host": {"S": "host"}, "hostEpoch": {"N": "1"},
				"startedAt": {"N": strconv.FormatInt(start, 10)}, "billedTo": {"N": strconv.FormatInt(billedTo, 10)},
				"lastListedAt": {"N": strconv.FormatInt(lastListed, 10)}, "leaseDeadline": {"N": strconv.FormatInt(now.Add(time.Minute).UnixMilli(), 10)},
			})
			body := "{}"
			switch r.Header.Get("X-Amz-Target") {
			case "DynamoDB_20120810.GetItem":
				body = `{"Item":` + string(row) + `}`
			case "DynamoDB_20120810.UpdateItem":
				body = `{"Attributes":` + string(row) + `}`
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Date": {time.Now().Add(offset).UTC().Format(http.TimeFormat)}},
				Body: io.NopCloser(strings.NewReader(body))}, nil
		}),
	})
	c := &Controller{DB: client, Tables: Tables{VMs: "vms", Usage: "usage"}, Now: func() time.Time { return now },
		Log: func(event string, _ map[string]any) {
			if event == "clock_skew" {
				warnings++
			}
		}}
	c.EnableClockCheck()
	for range 2 {
		if _, err := c.Listed(t.Context(), "vm", "host", 1, now); !errors.Is(err, ErrClockSkew) {
			t.Fatalf("listed: %v", err)
		}
	}
	if lastListed != now.UnixMilli() || billedTo != start || transactions != 0 || warnings != 1 {
		t.Fatalf("last listed %d, billed to %d, transactions %d, warnings %d", lastListed, billedTo, transactions, warnings)
	}
	offset = 0
	v, err := c.ExtendUsage(t.Context(), "vm", now)
	if err != nil || transactions != 1 || v.BilledTo != start+intervalMS {
		t.Fatalf("extend: %+v, %v, transactions %d", v, err, transactions)
	}
}

func TestUnitClockMissingDate(t *testing.T) {
	calls := 0
	c := &Controller{Tables: Tables{VMs: "vms"}, DB: dynamodb.New(dynamodb.Options{
		Region: "us-east-1", Credentials: credentials.NewStaticCredentialsProvider("test", "test", ""),
		HTTPClient: clockTransport(func(r *http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
		}),
	})}
	c.EnableClockCheck()
	if err := c.requireClock(context.Background(), "vm"); !errors.Is(err, ErrClockSkew) || calls != 1 {
		t.Fatalf("probe calls %d, error %v", calls, err)
	}
}
