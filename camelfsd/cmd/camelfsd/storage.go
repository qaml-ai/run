//go:build !guest

package main

import (
	"context"
	"flag"

	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type bundleFlags struct {
	table string
}

func (b *bundleFlags) bind(f *flag.FlagSet) {
	f.StringVar(&b.table, "objects-table", "", "DynamoDB objects table for blob locators")
}

func (b bundleFlags) open(ctx context.Context, url, region, endpoint string, depth int) (store.Store, error) {
	s, err := store.Open(ctx, url, region, depth)
	if err != nil || b.table == "" {
		return s, err
	}
	client, err := ddb.Open(ctx, ddb.Config{Region: region, Endpoint: endpoint})
	if err != nil {
		return nil, err
	}
	return store.WithBundles(s, client, b.table), nil
}
