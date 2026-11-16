package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

const restoreLineage = "tenant:restore"

func restoreLocatorRows(n int) ([]string, []locatorItem) {
	blob := newSmall([]byte("locator payload"))
	loc := blobLocation{
		BundleRef: BundleRef{Key: "p/" + blob.SHA256, SHA256: blob.SHA256, Size: int64(len(blob.Data)), PackSize: int64(len(blob.Data))},
		attempt:   "fixture",
	}
	ids := make([]string, n)
	rows := make([]locatorItem, n)
	for i := range ids {
		ids[i] = fmt.Sprintf("%040x", i+1)
		rows[i] = locationItem(restoreLineage, ids[i], loc)
	}
	return ids, rows
}

func TestRestoreLocatorQueryPages(t *testing.T) {
	ids, rows := restoreLocatorRows(101)
	history := objectKey(restoreLineage, fmt.Sprintf("%040x", 0))
	cursor := objectKey(restoreLineage, ids[49])
	pages := 0
	db := &bundleTestDB{query: func(_ context.Context, in *dynamodb.QueryInput) (*dynamodb.QueryOutput, error) {
		if !aws.ToBool(in.ConsistentRead) || aws.ToString(in.TableName) != "objects" ||
			aws.ToString(in.KeyConditionExpression) != "#lineage = :lineage AND begins_with(#id, :prefix)" ||
			itemString(in.ExpressionAttributeValues, ":lineage") != restoreLineage || itemString(in.ExpressionAttributeValues, ":prefix") != "o/" {
			t.Fatal("query did not strongly read only the lineage's blob locators")
		}
		pages++
		switch pages {
		case 1:
			if len(in.ExclusiveStartKey) != 0 {
				t.Fatal("first query already had a cursor")
			}
			return &dynamodb.QueryOutput{Items: append([]locatorItem{history}, rows[:50]...), LastEvaluatedKey: cursor}, nil
		case 2:
			if itemString(in.ExclusiveStartKey, "id") != itemString(cursor, "id") {
				t.Fatal("second query did not resume from the prior key")
			}
			// The SDK may return a cursor despite every requested locator having
			// been resolved. That should not trigger another query.
			return &dynamodb.QueryOutput{Items: rows[50:], LastEvaluatedKey: objectKey(restoreLineage, ids[100])}, nil
		default:
			t.Fatal("query continued after finding every requested locator")
			return nil, nil
		}
	}}
	s := ForLineage(WithBundles(Local{}, db, "objects"), restoreLineage)
	refs, err := LocateBundlesForRestore(t.Context(), s, append(ids, ids[0]))
	if err != nil || len(refs) != len(ids) || pages != 2 || db.batches != 0 {
		t.Fatalf("restore located %d ids in %d pages and %d batches: %v", len(refs), pages, db.batches, err)
	}
}

func TestRestoreLocatorQueryFailsLoudly(t *testing.T) {
	ids, rows := restoreLocatorRows(101)
	unavailable := errors.New("query unavailable")
	for _, name := range []string{"query error", "missing at EOF", "cancelled", "repeated cursor"} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			pages := 0
			db := &bundleTestDB{query: func(_ context.Context, _ *dynamodb.QueryInput) (*dynamodb.QueryOutput, error) {
				pages++
				switch name {
				case "query error":
					return nil, unavailable
				case "missing at EOF":
					return &dynamodb.QueryOutput{Items: rows[:100]}, nil
				case "cancelled":
					cancel()
				}
				return &dynamodb.QueryOutput{
					Items: rows[:1], LastEvaluatedKey: objectKey(restoreLineage, ids[0]),
				}, nil
			}}
			s := ForLineage(WithBundles(Local{}, db, "objects"), restoreLineage)
			_, err := LocateBundlesForRestore(ctx, s, ids)
			if err == nil || db.batches != 0 {
				t.Fatalf("expected a query failure without batch fallback, batches %d: %v", db.batches, err)
			}
			switch name {
			case "query error":
				if !errors.Is(err, unavailable) {
					t.Fatal(err)
				}
			case "missing at EOF":
				if !strings.Contains(err.Error(), "missing bundle locator") || !strings.Contains(err.Error(), ids[100]) {
					t.Fatal(err)
				}
			case "cancelled":
				if !errors.Is(err, context.Canceled) || pages != 1 {
					t.Fatalf("requested %d pages after cancellation: %v", pages, err)
				}
			case "repeated cursor":
				if !strings.Contains(err.Error(), "query cursor") || pages != 2 {
					t.Fatalf("requested %d pages: %v", pages, err)
				}
			}
		})
	}
}

func TestRestoreLocatorSmallLookupRequiresEveryLocator(t *testing.T) {
	ids, rows := restoreLocatorRows(2)
	db := &bundleTestDB{rows: map[string]locatorItem{locatorTestKey(rows[0]): rows[0]}}
	loose := ForLineage(Local{}, restoreLineage)
	if refs, err := LocateBundlesForRestore(t.Context(), loose, ids); len(refs) != 0 || err != nil {
		t.Fatalf("loose control requires no catalog: %v, %v", refs, err)
	}
	s := ForLineage(WithBundles(Local{}, db, "objects"), restoreLineage)
	if _, err := LocateBundlesForRestore(t.Context(), s, ids); err == nil || !strings.Contains(err.Error(), "missing bundle locator") || db.batches != 1 {
		t.Fatalf("small lookup batches=%d err=%v", db.batches, err)
	}
}
