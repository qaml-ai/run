package ddb

import (
	"errors"
	"fmt"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func TestIsConditionFailed(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{nil, false},
		{errors.New("ConditionalCheckFailed"), false},
		{&types.ConditionalCheckFailedException{}, true},
		{&types.TransactionCanceledException{CancellationReasons: []types.CancellationReason{
			{}, {Code: aws.String("ConditionalCheckFailed")},
		}}, true},
		{&types.TransactionCanceledException{CancellationReasons: []types.CancellationReason{
			{Code: aws.String("TransactionConflict")},
		}}, false},
	} {
		err := tc.err
		if err != nil {
			err = fmt.Errorf("wrapped: %w", err)
		}
		if got := IsConditionFailed(err); got != tc.want {
			t.Errorf("IsConditionFailed(%v) = %t, want %t", err, got, tc.want)
		}
	}
}
