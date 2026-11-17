package repo

import (
	"fmt"
	"strings"
)

func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	trimmed := strings.TrimSuffix(text, "\n")
	return strings.Split(trimmed, "\n")
}

type diffOpKind int

const (
	opEqual diffOpKind = iota
	opDelete
	opInsert
)

type diffOp struct {
	kind diffOpKind
	line string
}

func computeLineDiff(a, b []string) []diffOp {
	n, m := len(a), len(b)
	if n == 0 && m == 0 {
		return nil
	}
	if n == 0 {
		ops := make([]diffOp, m)
		for j := 0; j < m; j++ {
			ops[j] = diffOp{kind: opInsert, line: b[j]}
		}
		return ops
	}
	if m == 0 {
		ops := make([]diffOp, n)
		for i := 0; i < n; i++ {
			ops[i] = diffOp{kind: opDelete, line: a[i]}
		}
		return ops
	}

	// Trim common prefix & suffix first for speed on large files.
	prefix := 0
	for prefix < n && prefix < m && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < (n-prefix) && suffix < (m-prefix) && a[n-1-suffix] == b[m-1-suffix] {
		suffix++
	}

	aMid := a[prefix : n-suffix]
	bMid := b[prefix : m-suffix]

	var midOps []diffOp
	if len(aMid) == 0 && len(bMid) == 0 {
		midOps = nil
	} else if len(aMid)*len(bMid) > 4_000_000 {
		// Fallback for huge middle sections: delete old middle, insert new middle.
		for _, l := range aMid {
			midOps = append(midOps, diffOp{kind: opDelete, line: l})
		}
		for _, l := range bMid {
			midOps = append(midOps, diffOp{kind: opInsert, line: l})
		}
	} else {
		an, bm := len(aMid), len(bMid)
		dp := make([][]int, an+1)
		for i := range dp {
			dp[i] = make([]int, bm+1)
		}
		for i := an - 1; i >= 0; i-- {
			for j := bm - 1; j >= 0; j-- {
				if aMid[i] == bMid[j] {
					dp[i][j] = dp[i+1][j+1] + 1
				} else if dp[i+1][j] >= dp[i][j+1] {
					dp[i][j] = dp[i+1][j]
				} else {
					dp[i][j] = dp[i][j+1]
				}
			}
		}
		i, j := 0, 0
		for i < an || j < bm {
			if i < an && j < bm && aMid[i] == bMid[j] {
				midOps = append(midOps, diffOp{kind: opEqual, line: aMid[i]})
				i++
				j++
			} else if j == bm || (i < an && dp[i+1][j] >= dp[i][j+1]) {
				midOps = append(midOps, diffOp{kind: opDelete, line: aMid[i]})
				i++
			} else {
				midOps = append(midOps, diffOp{kind: opInsert, line: bMid[j]})
				j++
			}
		}
	}

	ops := make([]diffOp, 0, prefix+len(midOps)+suffix)
	for k := 0; k < prefix; k++ {
		ops = append(ops, diffOp{kind: opEqual, line: a[k]})
	}
	ops = append(ops, midOps...)
	for k := n - suffix; k < n; k++ {
		ops = append(ops, diffOp{kind: opEqual, line: a[k]})
	}
	return ops
}

// UnifiedPatch builds a unified diff patch between oldBytes and newBytes.
func UnifiedPatch(oldBytes, newBytes []byte) string {
	if IsBinary(oldBytes) || IsBinary(newBytes) {
		if string(oldBytes) == string(newBytes) {
			return ""
		}
		return "Binary files differ\n"
	}
	oldLines := splitLines(string(oldBytes))
	newLines := splitLines(string(newBytes))
	ops := computeLineDiff(oldLines, newLines)
	if len(ops) == 0 {
		return ""
	}

	const contextLines = 3
	type indexedOp struct {
		op      diffOp
		oldLine int
		newLine int
	}
	indexed := make([]indexedOp, len(ops))
	ol, nl := 1, 1
	hasChange := false
	for idx, op := range ops {
		indexed[idx] = indexedOp{op: op, oldLine: ol, newLine: nl}
		switch op.kind {
		case opEqual:
			ol++
			nl++
		case opDelete:
			hasChange = true
			ol++
		case opInsert:
			hasChange = true
			nl++
		}
	}
	if !hasChange {
		return ""
	}

	// Mark changed indices and surrounding context window.
	keep := make([]bool, len(indexed))
	for i, it := range indexed {
		if it.op.kind != opEqual {
			lo := i - contextLines
			if lo < 0 {
				lo = 0
			}
			hi := i + contextLines
			if hi >= len(indexed) {
				hi = len(indexed) - 1
			}
			for k := lo; k <= hi; k++ {
				keep[k] = true
			}
		}
	}

	var out strings.Builder
	i := 0
	for i < len(indexed) {
		if !keep[i] {
			i++
			continue
		}
		j := i
		for j < len(indexed) && keep[j] {
			j++
		}
		// Hunk covers indexed[i:j]
		oldStart := indexed[i].oldLine
		newStart := indexed[i].newLine
		oldCount, newCount := 0, 0
		for k := i; k < j; k++ {
			switch indexed[k].op.kind {
			case opEqual:
				oldCount++
				newCount++
			case opDelete:
				oldCount++
			case opInsert:
				newCount++
			}
		}
		if oldCount == 0 {
			oldStart = 0
		}
		if newCount == 0 {
			newStart = 0
		}
		fmt.Fprintf(&out, "@@ -%d,%d +%d,%d @@\n", oldStart, oldCount, newStart, newCount)
		for k := i; k < j; k++ {
			switch indexed[k].op.kind {
			case opEqual:
				out.WriteByte(' ')
				out.WriteString(indexed[k].op.line)
				out.WriteByte('\n')
			case opDelete:
				out.WriteByte('-')
				out.WriteString(indexed[k].op.line)
				out.WriteByte('\n')
			case opInsert:
				out.WriteByte('+')
				out.WriteString(indexed[k].op.line)
				out.WriteByte('\n')
			}
		}
		i = j
	}
	return out.String()
}

type editHunk struct {
	baseStart int      // 0-based inclusive index in base
	baseEnd   int      // 0-based exclusive index in base
	repl      []string // replacement lines
}

// extractHunks computes replacement hunks relative to base lines.
func extractHunks(base, side []string) []editHunk {
	ops := computeLineDiff(base, side)
	var hunks []editHunk
	bIdx := 0
	i := 0
	for i < len(ops) {
		if ops[i].kind == opEqual {
			bIdx++
			i++
			continue
		}
		start := bIdx
		var repl []string
		for i < len(ops) && ops[i].kind != opEqual {
			if ops[i].kind == opDelete {
				bIdx++
			} else if ops[i].kind == opInsert {
				repl = append(repl, ops[i].line)
			}
			i++
		}
		hunks = append(hunks, editHunk{
			baseStart: start,
			baseEnd:   bIdx,
			repl:      repl,
		})
	}
	return hunks
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func hunksOverlap(a, b editHunk) bool {
	// Identical zero-length insertion point conflicts unless replacement lines match.
	if a.baseStart == a.baseEnd && b.baseStart == b.baseEnd {
		return a.baseStart == b.baseStart
	}
	if a.baseStart == a.baseEnd {
		return a.baseStart > b.baseStart && a.baseStart < b.baseEnd || a.baseStart == b.baseStart
	}
	if b.baseStart == b.baseEnd {
		return b.baseStart > a.baseStart && b.baseStart < a.baseEnd || b.baseStart == a.baseStart
	}
	return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd
}

// MergeText3Way performs a diff3 line-level 3-way merge of ours and theirs from base.
// Returns (mergedBytes, true) when clean, or (nil, false) when conflicting hunks overlap.
func MergeText3Way(baseBytes, oursBytes, theirsBytes []byte) ([]byte, bool) {
	if string(oursBytes) == string(theirsBytes) {
		return oursBytes, true
	}
	if IsBinary(baseBytes) || IsBinary(oursBytes) || IsBinary(theirsBytes) {
		return nil, false
	}

	baseLines := splitLines(string(baseBytes))
	oursLines := splitLines(string(oursBytes))
	theirsLines := splitLines(string(theirsBytes))

	hOurs := extractHunks(baseLines, oursLines)
	hTheirs := extractHunks(baseLines, theirsLines)

	var merged []string
	basePos := 0
	oi, ti := 0, 0

	for oi < len(hOurs) || ti < len(hTheirs) {
		if ti >= len(hTheirs) {
			h := hOurs[oi]
			merged = append(merged, baseLines[basePos:h.baseStart]...)
			merged = append(merged, h.repl...)
			basePos = h.baseEnd
			oi++
			continue
		}
		if oi >= len(hOurs) {
			h := hTheirs[ti]
			merged = append(merged, baseLines[basePos:h.baseStart]...)
			merged = append(merged, h.repl...)
			basePos = h.baseEnd
			ti++
			continue
		}

		ho := hOurs[oi]
		ht := hTheirs[ti]

		if hunksOverlap(ho, ht) {
			// False conflict check: both sides made the exact same edit on the exact same span.
			if ho.baseStart == ht.baseStart && ho.baseEnd == ht.baseEnd && stringSlicesEqual(ho.repl, ht.repl) {
				merged = append(merged, baseLines[basePos:ho.baseStart]...)
				merged = append(merged, ho.repl...)
				basePos = ho.baseEnd
				oi++
				ti++
				continue
			}
			return nil, false
		}

		if ho.baseStart < ht.baseStart || (ho.baseStart == ht.baseStart && ho.baseEnd <= ht.baseStart) {
			merged = append(merged, baseLines[basePos:ho.baseStart]...)
			merged = append(merged, ho.repl...)
			basePos = ho.baseEnd
			oi++
		} else {
			merged = append(merged, baseLines[basePos:ht.baseStart]...)
			merged = append(merged, ht.repl...)
			basePos = ht.baseEnd
			ti++
		}
	}

	merged = append(merged, baseLines[basePos:]...)
	if len(merged) == 0 {
		return []byte{}, true
	}
	trailingNewline := strings.HasSuffix(string(oursBytes), "\n") || strings.HasSuffix(string(theirsBytes), "\n")
	joined := strings.Join(merged, "\n")
	if trailingNewline {
		joined += "\n"
	}
	return []byte(joined), true
}
