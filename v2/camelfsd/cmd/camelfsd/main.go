package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/api"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/auth"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/store"
	awsstore "github.com/qaml-ai/camelrun-next/camelfsd/internal/store/aws"
	localstore "github.com/qaml-ai/camelrun-next/camelfsd/internal/store/local"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/vm"
)

func main() {
	var (
		listenAddr   = flag.String("listen", envOr("CAMELFSD_LISTEN", "127.0.0.1:8790"), "HTTP listen address")
		dataDir      = flag.String("data-dir", envOr("CAMELFSD_DATA_DIR", "./data"), "Data directory for local backend and VM workspaces")
		backend      = flag.String("backend", envOr("CAMELFSD_BACKEND", "local"), "Storage backend: local | aws")
		vmDriverName = flag.String("vm-driver", envOr("CAMELFSD_VM_DRIVER", "local"), "VM driver: local | firecracker | remote")
		publicKeys   = flag.String("public-keys", os.Getenv("CAMELFSD_PUBLIC_KEYS"), "Comma-separated <kid>:<base64url-ed25519-pubkey> entries")
		devToken     = flag.String("dev-token", os.Getenv("CAMELFSD_DEV_TOKEN"), "Shared bearer secret fallback for local development")
		hostToken    = flag.String("host-token", os.Getenv("CAMELFSD_HOST_TOKEN"), "Shared token authenticating outbound compute hosts")

		awsRegion     = flag.String("aws-region", os.Getenv("AWS_REGION"), "AWS region for DynamoDB and S3")
		s3Bucket      = flag.String("s3-bucket", os.Getenv("CAMELFSD_S3_BUCKET"), "S3 bucket for content-addressed objects")
		ddbReposTable = flag.String("ddb-repos-table", envOr("CAMELFSD_DDB_REPOS_TABLE", "camelfs-repos"), "DynamoDB table for lineages, refs, and leases")
		ddbVMsTable   = flag.String("ddb-vms-table", envOr("CAMELFSD_DDB_VMS_TABLE", "camelfs-vms"), "DynamoDB table for VM sessions, exec receipts, and hosts")

		fcBin       = flag.String("firecracker-bin", envOr("CAMELFSD_FC_BIN", "firecracker"), "Path to firecracker binary")
		fcJailer    = flag.String("firecracker-jailer", os.Getenv("CAMELFSD_FC_JAILER"), "Path to the matching Firecracker jailer")
		fcKernel    = flag.String("firecracker-kernel", os.Getenv("CAMELFSD_FC_KERNEL"), "Path to Firecracker guest kernel image")
		fcRootfs    = flag.String("firecracker-rootfs", os.Getenv("CAMELFSD_FC_ROOTFS"), "Path to Firecracker guest rootfs ext4 image")
		fcVsockPort = flag.Int("firecracker-vsock-port", 10000, "Guest agent vsock port inside Firecracker microVM")
	)
	flag.Parse()

	ctx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()

	verifier, err := auth.NewVerifier(auth.Config{
		PublicKeysSpec: *publicKeys,
		DevToken:       *devToken,
		HostToken:      *hostToken,
	})
	if err != nil {
		log.Fatalf("camelfsd: invalid auth config: %v", err)
	}

	var st store.Store
	switch *backend {
	case "local":
		st, err = localstore.Open(*dataDir)
		if err != nil {
			log.Fatalf("camelfsd: open local store: %v", err)
		}
	case "aws":
		st, err = awsstore.Open(ctx, awsstore.Config{
			Region:     *awsRegion,
			Bucket:     *s3Bucket,
			ReposTable: *ddbReposTable,
			VMsTable:   *ddbVMsTable,
		})
		if err != nil {
			log.Fatalf("camelfsd: open aws store: %v", err)
		}
	default:
		log.Fatalf("camelfsd: unsupported --backend %q (expected local|aws)", *backend)
	}
	defer func() { _ = st.Close() }()

	hostMux := vm.NewHostMux(st, time.Now)

	repoEngine := repo.NewEngine(st, time.Now)

	var drv vm.Driver
	switch *vmDriverName {
	case "local":
		drv, err = vm.NewLocalDriver(*dataDir)
		if err != nil {
			log.Fatalf("camelfsd: init local VM driver: %v", err)
		}
	case "firecracker":
		fc, err := vm.NewFirecrackerDriver(vm.FirecrackerConfig{
			DataDir:         *dataDir,
			FirecrackerBin:  *fcBin,
			JailerBin:       *fcJailer,
			KernelImagePath: *fcKernel,
			RootfsImagePath: *fcRootfs,
			GetBlob:         repoEngine.GetBlob,
			VsockPort:       *fcVsockPort,
		})
		if err != nil {
			log.Fatalf("camelfsd: init firecracker VM driver: %v", err)
		}
		if err := fc.Recover(ctx, st); err != nil {
			log.Fatalf("camelfsd: recover firecracker VMs: %v", err)
		}
		drv = fc
	case "remote":
		drv = vm.NewRemoteDriver(hostMux)
	default:
		log.Fatalf("camelfsd: unsupported --vm-driver %q (expected local|firecracker|remote)", *vmDriverName)
	}

	vmMgr := vm.NewManager(vm.ManagerConfig{
		Store:   st,
		Repo:    repoEngine,
		Driver:  drv,
		HostMux: hostMux,
	})
	defer func() { _ = vmMgr.Close() }()

	handler := api.NewServer(verifier, repoEngine, vmMgr)
	httpSrv := &http.Server{
		Addr:              *listenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("camelfsd listening on http://%s (backend=%s vm-driver=%s)", *listenAddr, *backend, *vmDriverName)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		log.Printf("camelfsd shutting down...")
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	case err := <-errCh:
		if err != nil {
			fmt.Fprintf(os.Stderr, "camelfsd server error: %v\n", err)
			os.Exit(1)
		}
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
