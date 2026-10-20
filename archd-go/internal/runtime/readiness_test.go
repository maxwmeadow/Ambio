package runtime

import "testing"

func TestReadinessSaysWhatARunCanSee(t *testing.T) {
	installed := map[string]string{"node": "v22.1.0", "python3": "Python 3.12.1", "go": "go version go1.27"}
	probe := func(tool string, _ []string) (string, string) {
		if v, ok := installed[tool]; ok {
			return "/usr/bin/" + tool, v
		}
		return "", ""
	}
	got := readiness(map[string]int{"typescript": 40, "tsx": 10, "python": 12, "go": 7, "ruby": 3, "markdown": 99}, probe)
	if len(got) != 4 {
		t.Fatalf("four languages, documents ignored: %+v", got)
	}
	want := []struct{ lang, level, tool string }{
		{"JavaScript/TypeScript", "full", "node"},
		{"Python", "full", "python3"},
		{"Go", "full", "go"},
		{"Ruby", "missing", ""},
	}
	for i, w := range want {
		if got[i].Language != w.lang || got[i].Level != w.level || got[i].Tool != w.tool {
			t.Errorf("row %d: want %+v, got %+v", i, w, got[i])
		}
	}
	if got[0].Files != 50 {
		t.Errorf("TypeScript and TSX count together: %d", got[0].Files)
	}
}
