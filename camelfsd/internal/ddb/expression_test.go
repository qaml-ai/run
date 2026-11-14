package ddb_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var expressionWord = regexp.MustCompile(`[#:]?[A-Za-z_][A-Za-z0-9_]*`)

func TestExpressionAttributesAreAliased(t *testing.T) {
	keywords := map[string]bool{
		"SET": true, "ADD": true, "REMOVE": true, "DELETE": true,
		"AND": true, "OR": true, "NOT": true, "BETWEEN": true, "IN": true,
		"attribute_exists": true, "attribute_not_exists": true, "begins_with": true,
		"if_not_exists": true, "list_append": true, "contains": true, "size": true,
	}
	for _, dir := range []string{"../api", "../refstore"} {
		files, err := filepath.Glob(filepath.Join(dir, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range files {
			if strings.HasSuffix(file, "_test.go") {
				continue
			}
			body, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, file, body, 0)
			if err != nil {
				t.Fatal(err)
			}
			ast.Inspect(f, func(node ast.Node) bool {
				lit, ok := node.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					return true
				}
				value, err := strconv.Unquote(lit.Value)
				if err != nil {
					t.Fatal(err)
				}
				// Include fragments used to assemble condition and update expressions.
				// A bare name on either side of an operator must still be detected.
				if !strings.ContainsAny(value, "#:") &&
					!regexp.MustCompile(`^(SET|ADD|REMOVE|DELETE) |^(attribute_exists|attribute_not_exists|begins_with)\(`).MatchString(value) {
					return true
				}
				if !strings.ContainsAny(value, " =(),<>") {
					return true
				}
				if !strings.Contains(value, "#") && !strings.Contains(value, " = :") &&
					!regexp.MustCompile(`^(SET|ADD|REMOVE|DELETE) [a-zA-Z_]|^(attribute_exists|attribute_not_exists|begins_with)\(`).MatchString(value) {
					return true
				}
				for _, word := range expressionWord.FindAllString(value, -1) {
					if word[0] != '#' && word[0] != ':' && !keywords[word] {
						t.Errorf("%s: bare identifier %q in DynamoDB expression %q", fset.Position(lit.Pos()), word, value)
					}
				}
				return true
			})
		}
	}
}
