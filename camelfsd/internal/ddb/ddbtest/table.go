// Package ddbtest provisions isolated tables on DynamoDB Local.
package ddbtest

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
)

type Schema struct {
	Keys       []types.KeySchemaElement
	Attributes []types.AttributeDefinition
}

func Table(t *testing.T, schema Schema) (*dynamodb.Client, string) {
	t.Helper()
	endpoint := os.Getenv("CAMELFS_DDB_LOCAL")
	if endpoint == "" {
		t.Skip("CAMELFS_DDB_LOCAL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	client, err := ddb.Open(ctx, ddb.Config{Endpoint: endpoint})
	if err != nil {
		t.Fatal(err)
	}
	var suffix [12]byte
	rand.Read(suffix[:])
	name := fmt.Sprintf("camelfs-test-%x", suffix)
	_, err = client.CreateTable(ctx, &dynamodb.CreateTableInput{
		TableName: aws.String(name), KeySchema: schema.Keys, AttributeDefinitions: schema.Attributes,
		BillingMode: types.BillingModePayPerRequest,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := client.DeleteTable(ctx, &dynamodb.DeleteTableInput{TableName: aws.String(name)}); err != nil {
			t.Errorf("delete test table: %v", err)
		}
	})
	if err := dynamodb.NewTableExistsWaiter(client).Wait(ctx, &dynamodb.DescribeTableInput{TableName: aws.String(name)}, 30*time.Second); err != nil {
		t.Fatal(err)
	}
	return client, name
}
