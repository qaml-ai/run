package refstore

import (
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
)

func TestApplyMarkRetainsIncrements(t *testing.T) {
	ctx := t.Context()
	client, lineages := ddbtest.Table(t, ddbtest.Schema{
		Keys:       []types.KeySchemaElement{{AttributeName: aws.String("lineage"), KeyType: types.KeyTypeHash}},
		Attributes: []types.AttributeDefinition{{AttributeName: aws.String("lineage"), AttributeType: types.ScalarAttributeTypeS}},
	})
	const lineage = "t:repo"
	_, err := client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &lineages, Item: attributes{"lineage": str(lineage)}})
	if err != nil {
		t.Fatal(err)
	}
	s := New(client, "", func() time.Time { return time.UnixMilli(123) }, nil)
	s.GuardLineages(lineages)
	for _, n := range []int64{12, 7} {
		if err := s.AddWritten(ctx, lineage, n); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.ApplyMark(ctx, lineage, 9, 12, nil); err != nil {
		t.Fatal(err)
	}
	first, err := s.ReadUsage(ctx, lineage)
	if err != nil || first.MarkedAt == nil || *first.MarkedAt != 123 || first.MarkedBytes != 9 || first.WrittenSince != 7 {
		t.Fatalf("unexpected first mark: %+v %v", first, err)
	}
	if err := s.ApplyMark(ctx, lineage, 14, first.WrittenSince, first.MarkedAt); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyMark(ctx, lineage, 0, 0, first.MarkedAt); !ddb.IsConditionFailed(err) {
		t.Fatalf("stale mark must fail, got %v", err)
	}
	final, err := s.ReadUsage(ctx, lineage)
	if err != nil || final.MarkedAt == nil || *final.MarkedAt <= *first.MarkedAt || final.MarkedBytes != 14 || final.WrittenSince != 0 {
		t.Fatalf("unexpected final mark: %+v %v", final, err)
	}
}
