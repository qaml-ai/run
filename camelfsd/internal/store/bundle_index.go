package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

type BundleDB interface {
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	BatchGetItem(context.Context, *dynamodb.BatchGetItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error)
	PutItem(context.Context, *dynamodb.PutItemInput, ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
}

// WithBundles uses the objects table to read and publish canonical blob bundles.
func WithBundles(s Store, db BundleDB, table string) Store {
	return &bundled{Store: s, db: db, table: table}
}

type blobLocation struct {
	BundleRef
	attempt string
}

type locatorItem = map[string]types.AttributeValue

func objectKey(lineage, id string) locatorItem {
	return locatorItem{
		"lineage": &types.AttributeValueMemberS{Value: lineage},
		"id":      &types.AttributeValueMemberS{Value: "o/" + id},
	}
}

func locationItem(lineage, id string, loc blobLocation) locatorItem {
	item := objectKey(lineage, id)
	item["sha256"] = &types.AttributeValueMemberS{Value: loc.SHA256}
	item["size"] = &types.AttributeValueMemberN{Value: strconv.FormatInt(loc.Size, 10)}
	item["publication"] = &types.AttributeValueMemberS{Value: loc.attempt}
	item["pack"] = &types.AttributeValueMemberS{Value: loc.Key}
	item["offset"] = &types.AttributeValueMemberN{Value: strconv.FormatInt(loc.Offset, 10)}
	item["pack_size"] = &types.AttributeValueMemberN{Value: strconv.FormatInt(loc.PackSize, 10)}
	return item
}

func itemString(item locatorItem, k string) string {
	if v, ok := item[k].(*types.AttributeValueMemberS); ok {
		return v.Value
	}
	return ""
}

func itemNumber(item locatorItem, k string) int64 {
	if v, ok := item[k].(*types.AttributeValueMemberN); ok {
		if n, err := strconv.ParseInt(v.Value, 10, 64); err == nil {
			return n
		}
	}
	return -1
}

func parseLocation(item locatorItem, lineage, id string) (blobLocation, error) {
	loc := blobLocation{
		BundleRef: BundleRef{Key: itemString(item, "pack"), SHA256: itemString(item, "sha256"), Size: itemNumber(item, "size")},
		attempt:   itemString(item, "publication"),
	}
	bad := fmt.Errorf("invalid blob locator for %s/%s", lineage, id)
	loc.Offset, loc.PackSize = itemNumber(item, "offset"), itemNumber(item, "pack_size")
	if itemString(item, "lineage") != lineage || itemString(item, "id") != "o/"+id ||
		loc.attempt == "" || !ValidateBundleRef(loc.BundleRef) {
		return blobLocation{}, bad
	}
	return loc, nil
}

func (s *bundled) lookup(ctx context.Context, lineage, id string) (blobLocation, error) {
	out, err := s.db.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &s.table, Key: objectKey(lineage, id), ConsistentRead: aws.Bool(true),
	})
	if err != nil || len(out.Item) == 0 {
		return blobLocation{}, ioFailure(err)
	}
	return parseLocation(out.Item, lineage, id)
}

func (s *bundled) lookupBatch(ctx context.Context, lineage string, ids []string) (map[string]blobLocation, error) {
	result := make(map[string]blobLocation, len(ids))
	seen := make(map[string]bool, len(ids))
	keys := make([]locatorItem, 0, len(ids))
	for _, id := range ids {
		if !root.Hex(id, 40) {
			return nil, fmt.Errorf("invalid blob ID")
		}
		if !seen[id] {
			keys = append(keys, objectKey(lineage, id))
			seen[id] = true
		}
	}
	for len(keys) > 0 {
		count := min(100, len(keys))
		request := map[string]types.KeysAndAttributes{
			s.table: {Keys: keys[:count], ConsistentRead: aws.Bool(true)},
		}
		keys = keys[count:]
		for delay := 5 * time.Millisecond; len(request) > 0; delay = min(delay*2, time.Second) {
			out, err := s.db.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: request})
			if err != nil {
				return nil, ioFailure(err)
			}
			for _, item := range out.Responses[s.table] {
				id, ok := strings.CutPrefix(itemString(item, "id"), "o/")
				if !ok || !seen[id] {
					return nil, fmt.Errorf("unexpected blob locator")
				}
				loc, err := parseLocation(item, lineage, id)
				if err != nil {
					return nil, err
				}
				result[id] = loc
			}
			request = out.UnprocessedKeys
			if len(request) > 0 {
				select {
				case <-time.After(delay):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
		}
	}
	return result, nil
}

func (s *bundled) publish(ctx context.Context, lineage, id string, wanted blobLocation) (bool, error) {
	_, err := s.db.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &s.table, Item: locationItem(lineage, id, wanted),
		ConditionExpression:      aws.String("attribute_not_exists(#id)"),
		ExpressionAttributeNames: map[string]string{"#id": "id"},
	})
	if err == nil {
		return true, nil
	}
	// Conditional failure can mean the SDK retried a request that already
	// committed. A strongly consistent lookup distinguishes that from losing
	// to another writer. An unknown result remains an error.
	found, lookupErr := s.lookup(ctx, lineage, id)
	if lookupErr != nil || found.SHA256 == "" {
		return false, errors.Join(ioFailure(err), lookupErr)
	}
	if err := checkBlobInfo(id, Info{Size: found.Size, SHA256: found.SHA256}, Info{Size: wanted.Size, SHA256: wanted.SHA256}); err != nil {
		return false, err
	}
	return found.attempt == wanted.attempt, nil
}
