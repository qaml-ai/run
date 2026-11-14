package store

// validReadKey admits only keys in the immutable object namespace.
func validReadKey(key string) bool { return valid(key) }
