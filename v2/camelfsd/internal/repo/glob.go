package repo

import (
	"regexp"
	"strings"
)

// CompileGlob compiles a slash-separated glob supporting **, *, ?, [...], and {a,b}
// into a regular expression.
func CompileGlob(pattern string) (*regexp.Regexp, error) {
	pattern = strings.TrimPrefix(strings.ReplaceAll(strings.TrimSpace(pattern), "\\", "/"), "/")
	var b strings.Builder
	b.WriteString("^")

	i := 0
	n := len(pattern)
	inBrace := 0
	for i < n {
		ch := pattern[i]
		switch ch {
		case '*':
			if i+1 < n && pattern[i+1] == '*' {
				// "**/" matches zero or more directories; "**" at end matches anything.
				if i+2 < n && pattern[i+2] == '/' {
					b.WriteString("(?:.*/)?")
					i += 3
					continue
				}
				b.WriteString(".*")
				i += 2
				continue
			}
			b.WriteString("[^/]*")
		case '?':
			b.WriteString("[^/]")
		case '.', '+', '^', '$', '(', ')', '|', '\\':
			b.WriteByte('\\')
			b.WriteByte(ch)
		case '[':
			j := i + 1
			if j < n && pattern[j] == '!' {
				j++
			}
			if j < n && pattern[j] == ']' {
				j++
			}
			for j < n && pattern[j] != ']' {
				j++
			}
			if j < n {
				inner := pattern[i+1 : j]
				if strings.HasPrefix(inner, "!") {
					inner = "^" + inner[1:]
				}
				b.WriteByte('[')
				b.WriteString(inner)
				b.WriteByte(']')
				i = j + 1
				continue
			}
			b.WriteString("\\[")
		case '{':
			inBrace++
			b.WriteString("(?:")
		case '}':
			if inBrace > 0 {
				inBrace--
				b.WriteByte(')')
			} else {
				b.WriteString("\\}")
			}
		case ',':
			if inBrace > 0 {
				b.WriteByte('|')
			} else {
				b.WriteByte(',')
			}
		default:
			b.WriteByte(ch)
		}
		i++
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}
