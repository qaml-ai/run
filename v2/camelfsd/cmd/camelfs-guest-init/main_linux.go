// camelfs-guest-init runs as PID 1 of the v2 Firecracker guest.
package main

import (
	"log"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/vm"
)

func main() {
	log.Fatal(vm.ServeFirecrackerGuest())
}
