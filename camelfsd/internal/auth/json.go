package auth

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

func jsonObject(raw []byte) (map[string]json.RawMessage, error) {
	if !utf8.Valid(raw) {
		return nil, errors.New("invalid UTF-8")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	first, err := d.Token()
	if err != nil || first != json.Delim('{') {
		return nil, errors.New("expected a JSON object")
	}
	if err := checkJSON(d, first); err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errors.New("extra JSON")
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	return obj, nil
}

// Walk all objects, including unknown fields, before decoding into maps.
func checkJSON(d *json.Decoder, first json.Token) error {
	switch first {
	case json.Delim('{'):
		seen := make(map[string]struct{})
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return err
			}
			name := key.(string)
			if _, exists := seen[name]; exists {
				return errors.New("duplicate JSON key")
			}
			seen[name] = struct{}{}
			value, err := d.Token()
			if err != nil {
				return err
			}
			if err := checkJSON(d, value); err != nil {
				return err
			}
		}
	case json.Delim('['):
		for d.More() {
			value, err := d.Token()
			if err != nil {
				return err
			}
			if err := checkJSON(d, value); err != nil {
				return err
			}
		}
	default:
		return nil
	}
	_, err := d.Token()
	return err
}

func stringField(obj map[string]json.RawMessage, name string) string {
	var s string
	_ = json.Unmarshal(obj[name], &s)
	return s
}

func integerField(obj map[string]json.RawMessage, name string) (int64, bool) {
	var n *int64
	if json.Unmarshal(obj[name], &n) != nil || n == nil {
		return 0, false
	}
	return *n, true
}
