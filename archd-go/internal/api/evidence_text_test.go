package api

import (
	"encoding/json"
	"testing"

	"ambio.local/archd/internal/runtime"
)

// The sentences an agent reads about a watched function's return values.
func TestReturnsTextSummarisesWhatAFunctionGaveBack(t *testing.T) {
	low, high := 2.0, 9.5
	for _, tc := range []struct {
		name  string
		stats runtime.ValueStats
		calls int64
		want  string
	}{
		{"never returned", runtime.ValueStats{}, 4, ""},
		{"always the same", runtime.ValueStats{Count: 4, First: "true"}, 4, "always true"},
		{"same, but not every call returned", runtime.ValueStats{Count: 2, First: "0"}, 5, "0 (on the 2 calls that returned)"},
		{"too varied", runtime.ValueStats{Count: 9, Changes: 8, Distinct: json.RawMessage(`"50+"`)}, 9, ""},
		{"a numeric range", runtime.ValueStats{Count: 9, Changes: 8, Kind: "number", Min: &low, Max: &high, Trend: "rising", Distinct: json.RawMessage(`9`)}, 9, "2 to 9.5 (rising)"},
		{"otherwise a count", runtime.ValueStats{Count: 9, Changes: 8, Kind: "string", Distinct: json.RawMessage(`"7"`)}, 9, "7 distinct values"},
	} {
		if got := returnsText(tc.stats, tc.calls); got != tc.want {
			t.Fatalf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestSeriesTextShowsTheStartAndTheLastValue(t *testing.T) {
	stats := runtime.ValueStats{Count: 10, Series: []string{"1", "2", "3", "4", "5", "6", "7"}, Last: "10"}
	if got := seriesText(stats); got != "1, 2, 3, 4, 5, 6 … 10" {
		t.Fatalf("got %q", got)
	}
	if got := seriesText(runtime.ValueStats{Count: 2, Series: []string{"a", "b"}}); got != "a, b" {
		t.Fatalf("got %q", got)
	}
}

// Samples keep the first two calls, one of each other outcome, any that threw
// or mutated, and the last - never the whole run.
func TestPickSamplesKeepsTheCallsWorthReading(t *testing.T) {
	ret := func(s string) *string { return &s }
	all := []runtime.CallSample{
		{Call: 1, Returned: ret("1")},
		{Call: 2, Returned: ret("2")},
		{Call: 3, Returned: ret("3")},                         // same shape: dropped
		{Call: 4, Returned: ret("undefined")},                 // new shape: kept
		{Call: 5, Threw: "TypeError"},                         // threw: kept
		{Call: 6, Returned: ret("4"), Mutated: []string{"x"}}, // mutated: kept
		{Call: 7, Returned: ret("5")},                         // last: kept
	}
	var calls []int
	for _, s := range pickSamples(all) {
		calls = append(calls, s.Call)
	}
	want := []int{1, 2, 4, 5, 6, 7}
	if len(calls) != len(want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Fatalf("calls = %v, want %v", calls, want)
		}
	}
	if short := pickSamples(all[:3]); len(short) != 3 {
		t.Fatalf("a short run is shown whole: %d", len(short))
	}
}

func TestADriftingValueInsideAMutatedCollectionIsAlreadyExplained(t *testing.T) {
	mutated := map[string]bool{"cart.items": true}
	for path, want := range map[string]bool{
		"cart.items.length": true,
		"cart.items[2].qty": true,
		"cart.total":        false,
		"order":             false,
	} {
		if got := explainedByMutation(path, mutated); got != want {
			t.Fatalf("%s: got %v", path, got)
		}
	}
}

func TestPlacesAndDurationsReadNaturally(t *testing.T) {
	if got := where(runtime.Anchor{RelPath: "src/a.ts", Line: 12}); got != "src/a.ts:12" {
		t.Fatalf("got %q", got)
	}
	if got := where(runtime.Anchor{RelPath: "src/a.ts"}); got != "src/a.ts" {
		t.Fatalf("got %q", got)
	}
	if got := where(runtime.Anchor{}); got != "" {
		t.Fatalf("got %q", got)
	}
	if humanMs(850) != "850ms" || humanMs(2300) != "2.3s" {
		t.Fatalf("humanMs: %s %s", humanMs(850), humanMs(2300))
	}
}
