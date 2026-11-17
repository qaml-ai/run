//go:build linux && kvm

package computehost

import (
	"fmt"
	"strings"
	"testing"
)

type coldSessionOptions struct {
	packedMode, content                     string
	packedParallel, cleanImage, imageRanges bool
}

// Parse the selected arm before opening a store or creating fixture files.
func parseColdSessionOptions(getenv func(string) string) (coldSessionOptions, error) {
	var options coldSessionOptions
	options.packedMode = getenv("CAMELFSD_KVM_PACKED_APPLY")
	switch options.packedMode {
	case "", "control", "plain", "gzip":
	default:
		return options, fmt.Errorf("CAMELFSD_KVM_PACKED_APPLY must be unset, control, plain or gzip")
	}
	for _, flag := range []struct {
		name  string
		value *bool
	}{
		{"CAMELFSD_KVM_PACKED_PARALLEL", &options.packedParallel},
		{"CAMELFSD_KVM_CLEAN_IMAGE", &options.cleanImage},
		{"CAMELFSD_KVM_IMAGE_RANGES", &options.imageRanges},
	} {
		switch getenv(flag.name) {
		case "", "0":
		case "1":
			*flag.value = true
		default:
			return options, fmt.Errorf("%s must be unset, 0 or 1", flag.name)
		}
	}
	if options.cleanImage && options.packedParallel {
		return options, fmt.Errorf("CAMELFSD_KVM_CLEAN_IMAGE and CAMELFSD_KVM_PACKED_PARALLEL are mutually exclusive")
	}
	if options.packedParallel && options.packedMode != "plain" {
		return options, fmt.Errorf("CAMELFSD_KVM_PACKED_PARALLEL requires CAMELFSD_KVM_PACKED_APPLY=plain")
	}
	if options.cleanImage && options.packedMode != "control" {
		return options, fmt.Errorf("CAMELFSD_KVM_CLEAN_IMAGE requires CAMELFSD_KVM_PACKED_APPLY=control")
	}
	if options.imageRanges && !options.cleanImage {
		return options, fmt.Errorf("CAMELFSD_KVM_IMAGE_RANGES requires CAMELFSD_KVM_CLEAN_IMAGE=1")
	}
	options.content = getenv("CAMELFSD_KVM_CONTENT")
	if options.content != "" && options.content != "random" && options.content != "source" {
		return options, fmt.Errorf("CAMELFSD_KVM_CONTENT must be unset, random or source")
	}
	return options, nil
}

func TestColdSessionOptions(t *testing.T) {
	for _, test := range []struct {
		name string
		env  map[string]string
		want coldSessionOptions
	}{
		{name: "legacy-default"},
		{name: "explicit-disabled", env: map[string]string{"PACKED_PARALLEL": "0", "CLEAN_IMAGE": "0", "IMAGE_RANGES": "0"}},
		{name: "canonical", env: map[string]string{"PACKED_APPLY": "control"}, want: coldSessionOptions{packedMode: "control"}},
		{name: "plain", env: map[string]string{"PACKED_APPLY": "plain"}, want: coldSessionOptions{packedMode: "plain"}},
		{name: "gzip", env: map[string]string{"PACKED_APPLY": "gzip"}, want: coldSessionOptions{packedMode: "gzip"}},
		{name: "parallel-apply", env: map[string]string{"PACKED_APPLY": "plain", "PACKED_PARALLEL": "1"}, want: coldSessionOptions{packedMode: "plain", packedParallel: true}},
		{name: "image", env: map[string]string{"PACKED_APPLY": "control", "CLEAN_IMAGE": "1"}, want: coldSessionOptions{packedMode: "control", cleanImage: true}},
		{name: "parallel-image", env: map[string]string{"PACKED_APPLY": "control", "CLEAN_IMAGE": "1", "IMAGE_RANGES": "1"}, want: coldSessionOptions{packedMode: "control", cleanImage: true, imageRanges: true}},
		{name: "random", env: map[string]string{"CONTENT": "random"}, want: coldSessionOptions{content: "random"}},
		{name: "source", env: map[string]string{"PACKED_APPLY": "gzip", "CONTENT": "source"}, want: coldSessionOptions{packedMode: "gzip", content: "source"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseColdSessionOptions(func(key string) string { return test.env[strings.TrimPrefix(key, "CAMELFSD_KVM_")] })
			if err != nil || got != test.want {
				t.Fatalf("got %+v, %v; want %+v", got, err, test.want)
			}
		})
	}
	for _, test := range []struct {
		name, option string
		env          map[string]string
	}{
		{"unknown-arm", "PACKED_APPLY", map[string]string{"PACKED_APPLY": "tar"}},
		{"parallel-without-arm", "PACKED_PARALLEL", map[string]string{"PACKED_PARALLEL": "1"}},
		{"parallel-control", "PACKED_PARALLEL", map[string]string{"PACKED_APPLY": "control", "PACKED_PARALLEL": "1"}},
		{"parallel-gzip", "PACKED_PARALLEL", map[string]string{"PACKED_APPLY": "gzip", "PACKED_PARALLEL": "1"}},
		{"image-without-control", "CLEAN_IMAGE", map[string]string{"CLEAN_IMAGE": "1"}},
		{"image-with-plain", "CLEAN_IMAGE", map[string]string{"PACKED_APPLY": "plain", "CLEAN_IMAGE": "1"}},
		{"image-with-gzip", "CLEAN_IMAGE", map[string]string{"PACKED_APPLY": "gzip", "CLEAN_IMAGE": "1"}},
		{"image-with-ranged-apply", "CLEAN_IMAGE", map[string]string{"PACKED_APPLY": "plain", "PACKED_PARALLEL": "1", "CLEAN_IMAGE": "1"}},
		{"image-ranges-without-image", "IMAGE_RANGES", map[string]string{"PACKED_APPLY": "control", "IMAGE_RANGES": "1"}},
		{"image-ranges-on-plain", "IMAGE_RANGES", map[string]string{"PACKED_APPLY": "plain", "IMAGE_RANGES": "1"}},
		{"unknown-content", "CONTENT", map[string]string{"CONTENT": "code"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseColdSessionOptions(func(key string) string { return test.env[strings.TrimPrefix(key, "CAMELFSD_KVM_")] })
			if err == nil || !strings.Contains(err.Error(), "CAMELFSD_KVM_"+test.option) {
				t.Fatalf("expected %s option error, got %v", test.option, err)
			}
		})
	}
	for _, flag := range []string{"PACKED_PARALLEL", "CLEAN_IMAGE", "IMAGE_RANGES"} {
		for _, value := range []string{"true", "false", "2", "-1", " 1"} {
			t.Run(flag+"="+value, func(t *testing.T) {
				_, err := parseColdSessionOptions(func(key string) string {
					if key == "CAMELFSD_KVM_"+flag {
						return value
					}
					return ""
				})
				if err == nil || !strings.Contains(err.Error(), "CAMELFSD_KVM_"+flag) {
					t.Fatalf("expected invalid boolean error, got %v", err)
				}
			})
		}
	}
}
