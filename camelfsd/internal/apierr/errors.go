package apierr

import "fmt"

type Error struct {
	Status int
	Code   string
	Cause  error
}

func (e *Error) Error() string { return e.Cause.Error() }
func (e *Error) Unwrap() error { return e.Cause }
func Invalid(format string, args ...any) error {
	return &Error{400, "invalid-request", fmt.Errorf(format, args...)}
}
