package main

import (
	"math"
	"sort"
	"time"
)

func percentile(values []time.Duration, p float64) float64 {
	if len(values) == 0 {
		return 0
	}
	copyOf := append([]time.Duration(nil), values...)
	sort.Slice(copyOf, func(i, j int) bool { return copyOf[i] < copyOf[j] })
	rank := max(1, int(math.Ceil(p*float64(len(copyOf)))))
	return float64(copyOf[min(rank, len(copyOf))-1]) / float64(time.Millisecond)
}

type prices struct{ standard, express, retrieval float64 }

func estimateCost(express bool, attempts int64, sizes []int64, p prices) float64 {
	if !express {
		return float64(attempts) / 1000 * p.standard
	}
	cost := float64(attempts) / 1000 * p.express
	for _, size := range sizes {
		cost += float64(max(int64(0), size-524288)) / 1e9 * p.retrieval
	}
	return cost
}
