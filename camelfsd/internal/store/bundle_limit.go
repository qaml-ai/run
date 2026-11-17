//go:build !kvm || !camelfs_medium_bundles

package store

const BundleMaxBlob = 64 << 10
