package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
)

type lineageItem struct {
	Lineage       string `json:"lineage"`
	Tenant        string `json:"tenant"`
	Kind          string `json:"kind"`
	DefaultBranch string `json:"defaultBranch"`
	CreatedAt     int64  `json:"createdAt"`
	DeletedAt     *int64 `json:"-"`
	Deletion      string `json:"-"`
	Clearing      bool   `json:"-"`
}

type lineageStore struct {
	client *dynamodb.Client
	table  *string
	now    func() time.Time
}

func lineageKey(l string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"lineage": &types.AttributeValueMemberS{Value: l}}
}

func (s *lineageStore) get(ctx context.Context, l string) (lineageItem, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{TableName: s.table, Key: lineageKey(l), ConsistentRead: aws.Bool(true)})
	if err != nil {
		return lineageItem{}, err
	}
	item := out.Item
	str := func(key string) string {
		if v, ok := item[key].(*types.AttributeValueMemberS); ok {
			return v.Value
		}
		return ""
	}
	number := func(key string) int64 {
		v, ok := item[key].(*types.AttributeValueMemberN)
		if !ok {
			return 0
		}
		n, parseErr := strconv.ParseInt(v.Value, 10, 64)
		if parseErr != nil {
			err = parseErr
		}
		return n
	}
	body := lineageItem{Lineage: str("lineage"), Tenant: str("tenant"), Kind: str("kind"), DefaultBranch: str("defaultBranch"),
		CreatedAt: number("createdAt"), Deletion: str("deletion")}
	if item["deletedAt"] != nil {
		n := number("deletedAt")
		body.DeletedAt = &n
	}
	if v, ok := item["clearing"].(*types.AttributeValueMemberBOOL); ok {
		body.Clearing = v.Value
	}
	return body, err
}

func (s *lineageStore) create(ctx context.Context, l string, body lineageItem) (lineageItem, int, error) {
	body.Lineage, body.CreatedAt = l, s.now().UnixMilli()
	item := map[string]types.AttributeValue{
		"lineage":       &types.AttributeValueMemberS{Value: l},
		"tenant":        &types.AttributeValueMemberS{Value: body.Tenant},
		"kind":          &types.AttributeValueMemberS{Value: body.Kind},
		"defaultBranch": &types.AttributeValueMemberS{Value: body.DefaultBranch},
		"createdAt":     &types.AttributeValueMemberN{Value: strconv.FormatInt(body.CreatedAt, 10)},
	}
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{TableName: s.table, Item: item,
		ConditionExpression:      aws.String("attribute_not_exists(#lineage)"),
		ExpressionAttributeNames: map[string]string{"#lineage": "lineage"}})
	if !ddb.IsConditionFailed(err) {
		return body, 201, err
	}
	existing, err := s.get(ctx, l)
	if err != nil {
		return lineageItem{}, 0, err
	}
	if existing.DeletedAt != nil {
		return lineageItem{}, 0, lineageDeleted()
	}
	if existing.Tenant != body.Tenant {
		return lineageItem{}, 0, &storageError{409, "lineage_conflict", map[string]any{"tenant": existing.Tenant}}
	}
	return existing, 200, nil
}

func lineageDeleted() error { return &storageError{410, "lineage_deleted", nil} }
func lineageMissing() error { return &storageError{404, "not_found", nil} }

func (s *lineageStore) change(ctx context.Context, l, condition, update string, names map[string]string, values map[string]types.AttributeValue) error {
	_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{TableName: s.table, Key: lineageKey(l),
		ConditionExpression: aws.String(condition), UpdateExpression: aws.String(update),
		ExpressionAttributeNames: names, ExpressionAttributeValues: values})
	return err
}

func (s *lineageStore) delete(ctx context.Context, l string, refs *refstore.Store) error {
	for {
		item, err := s.get(ctx, l)
		if err != nil {
			return err
		}
		if item.DeletedAt != nil {
			return lineageDeleted()
		}
		if item.Lineage == "" {
			return lineageMissing()
		}
		if item.Deletion == "" {
			id := make([]byte, 16)
			if _, err := rand.Read(id); err != nil {
				return err
			}
			err := s.change(ctx, l, "attribute_not_exists(#deletion) AND attribute_not_exists(#deletedAt)",
				"SET #deletion = :id", map[string]string{"#deletion": "deletion", "#deletedAt": "deletedAt"},
				map[string]types.AttributeValue{":id": &types.AttributeValueMemberS{Value: hex.EncodeToString(id)}})
			if err == nil || ddb.IsConditionFailed(err) {
				continue
			}
			return err
		}
		names := map[string]string{"#deletion": "deletion", "#clearing": "clearing"}
		values := map[string]types.AttributeValue{":id": &types.AttributeValueMemberS{Value: item.Deletion}}
		if !item.Clearing {
			held, err := refs.Held(ctx, l)
			if err != nil {
				return err
			}
			condition := "#deletion = :id AND attribute_not_exists(#clearing)"
			update := "REMOVE #deletion"
			if len(held) == 0 {
				update = "SET #clearing = :yes"
				values[":yes"] = &types.AttributeValueMemberBOOL{Value: true}
			}
			err = s.change(ctx, l, condition, update, names, values)
			if ddb.IsConditionFailed(err) {
				continue
			}
			if err != nil {
				return err
			}
			if len(held) > 0 {
				return &storageError{409, "held", map[string]any{"held": held}}
			}
			continue
		}
		if err := refs.ClearDeleting(ctx, l); err != nil {
			return err
		}
		names["#deletedAt"] = "deletedAt"
		values[":now"] = &types.AttributeValueMemberN{Value: strconv.FormatInt(s.now().UnixMilli(), 10)}
		err = s.change(ctx, l, "#deletion = :id AND attribute_exists(#clearing)",
			"SET #deletedAt = :now REMOVE #deletion, #clearing", names, values)
		if ddb.IsConditionFailed(err) {
			continue
		}
		return err
	}
}

func (s *StorageServer) lineageRoute(w http.ResponseWriter, r *http.Request, l string, item lineageItem) error {
	switch r.Method {
	case "GET":
		if item.Lineage == "" {
			return lineageMissing()
		}
		jsonReply(w, 200, item)
	case "PUT":
		var body struct{ Tenant, Kind, DefaultBranch string }
		if err := decodeStorage(r, &body); err != nil {
			return err
		}
		if body.Tenant == "" || (body.Kind != "workspace" && body.Kind != "image") || !refstore.ValidName(body.DefaultBranch) {
			return invalid("tenant, kind and defaultBranch are required")
		}
		created, status, err := s.lineages.create(r.Context(), l, lineageItem{Tenant: body.Tenant, Kind: body.Kind, DefaultBranch: body.DefaultBranch})
		if err != nil {
			return err
		}
		jsonReply(w, status, created)
	case "DELETE":
		if err := s.lineages.delete(r.Context(), l, s.refs); err != nil {
			return err
		}
		w.WriteHeader(204)
	default:
		authFail(w, http.StatusNotFound, "not_found", "route not found")
	}
	return nil
}
