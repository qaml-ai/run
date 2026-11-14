//go:build guest

package main

import "fmt"

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: camelfsd guest|init")
	}
	return runGuest(args)
}
