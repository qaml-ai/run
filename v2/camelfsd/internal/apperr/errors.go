package apperr

import (
	"errors"
	"fmt"
	"net/http"
)

type Code string

const (
	CodeNotFound       Code = "not_found"
	CodeCASConflict    Code = "cas_conflict"
	CodeRefLeased      Code = "ref_leased"
	CodeInvalidRequest Code = "invalid_request"
	CodeUnauthorized   Code = "unauthorized"
	CodeTimeout        Code = "timeout"
	CodeInternal       Code = "internal"
)

type Error struct {
	Code      Code
	Status    int
	Message   string
	Conflicts []string
	Err       error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s (%v)", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error {
	return e.Err
}

func NotFound(msg string) *Error {
	return &Error{Code: CodeNotFound, Status: http.StatusNotFound, Message: msg}
}

func NotFoundf(format string, args ...any) *Error {
	return NotFound(fmt.Sprintf(format, args...))
}

func CASConflict(msg string) *Error {
	return &Error{Code: CodeCASConflict, Status: http.StatusConflict, Message: msg}
}

func CASConflictf(format string, args ...any) *Error {
	return CASConflict(fmt.Sprintf(format, args...))
}

func MergeConflict(conflicts []string) *Error {
	return &Error{
		Code:      CodeCASConflict,
		Status:    http.StatusConflict,
		Message:   "merge conflict",
		Conflicts: conflicts,
	}
}

func RefLeased(msg string) *Error {
	return &Error{Code: CodeRefLeased, Status: http.StatusConflict, Message: msg}
}

func RefLeasedf(format string, args ...any) *Error {
	return RefLeased(fmt.Sprintf(format, args...))
}

func InvalidRequest(msg string) *Error {
	return &Error{Code: CodeInvalidRequest, Status: http.StatusBadRequest, Message: msg}
}

func InvalidRequestf(format string, args ...any) *Error {
	return InvalidRequest(fmt.Sprintf(format, args...))
}

func Unauthorized(msg string) *Error {
	return &Error{Code: CodeUnauthorized, Status: http.StatusUnauthorized, Message: msg}
}

func Forbidden(msg string) *Error {
	return &Error{Code: CodeUnauthorized, Status: http.StatusForbidden, Message: msg}
}

func Timeout(msg string) *Error {
	return &Error{Code: CodeTimeout, Status: http.StatusGatewayTimeout, Message: msg}
}

func Internal(msg string, err error) *Error {
	return &Error{Code: CodeInternal, Status: http.StatusInternalServerError, Message: msg, Err: err}
}

func As(err error) (*Error, bool) {
	var ae *Error
	if errors.As(err, &ae) {
		return ae, true
	}
	return nil, false
}

func IsCode(err error, code Code) bool {
	ae, ok := As(err)
	return ok && ae.Code == code
}
