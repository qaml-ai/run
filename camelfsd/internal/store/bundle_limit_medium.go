//go:build kvm && camelfs_medium_bundles

package store

// Dedicated KVM benchmarks compare one MiB members in the existing packs.
const BundleMaxBlob = 1 << 20
