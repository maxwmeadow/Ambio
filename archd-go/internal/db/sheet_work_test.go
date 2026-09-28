package db

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSheetFileRealizationRechecksDriftUntilArchived(t *testing.T) {
	d, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(UpsertWorkspace(d, Workspace{ID: "ws", Name: "Test"}))
	root := t.TempDir()
	must(UpsertRoot(d, Root{ID: "root", WorkspaceID: "ws", Path: root, IsActive: true}))
	path := filepath.Join(root, "rate.ts")
	must(os.WriteFile(path, []byte("interface RateLimiter {\n allow(key: string): boolean\n}\n"), 0600))
	must(UpsertFile(d, File{ID: "file", RootID: "root", Path: path, RelPath: "rate.ts", Language: "typescript"}))
	must(UpsertSymbols(d, "file", []Symbol{{Name: "RateLimiter", Kind: "interface", LineStart: 1, LineEnd: 3}, {Name: "allow", Kind: "method", LineStart: 2, LineEnd: 2}}))
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "Design"}
	must(CreateSheet(d, &sheet))
	p := PlannedNode{ID: "p", SheetID: sheet.ID, WorkspaceID: "ws", Name: "RateLimiter", DeclaredPath: "rate.ts", Kind: "class", Metadata: json.RawMessage(`{"version":1,"methods":[{"name":"allow","parameters":[{"name":"key","dataType":"string"}],"returnType":"boolean"}]}`)}
	must(UpsertPlannedNode(d, &p))
	_, err = ReconcilePlanned(d, "ws")
	must(err)
	c, err := CompareSheetStructure(d, "ws", sheet.ID)
	must(err)
	if !c.Equivalent {
		t.Fatalf("implemented file: %+v", c.Differences)
	}
	must(os.WriteFile(path, []byte("interface RateLimiter {\n allow(key: number): string\n}\n"), 0600))
	_, err = ReconcilePlanned(d, "ws")
	must(err)
	c, err = CompareSheetStructure(d, "ws", sheet.ID)
	must(err)
	if c.Equivalent {
		t.Fatal("previously realized contract stayed green after drift")
	}
	_, err = d.Exec(`INSERT INTO sheet_resolutions(sheet_id,revision,resolved_at,comparison,context) VALUES(?,?,1,'{}','{}')`, sheet.ID, c.Revision)
	must(err)
	open, err := GetOpenPlannedNodes(d, "ws")
	must(err)
	if len(open) != 0 {
		t.Fatal("archived design was still being rewritten by reconciliation")
	}
}

func TestSheetInfraNestingAndContainmentEdges(t *testing.T) {
	d, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(UpsertWorkspace(d, Workspace{ID: "ws", Name: "Test"}))
	must(UpsertInfraNode(d, &InfraNode{ID: "host", WorkspaceID: "ws", Name: "Host", Category: "platform"}))
	must(UpsertSystem(d, System{ID: "child", WorkspaceID: "ws", Name: "Service", Source: "user"}))
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "Deployment"}
	must(CreateSheet(d, &sheet))
	parent, parentType := "host", "infra"
	_, err = ApplySheetLayoutBatch(d, sheet.ID, "ws", []SheetLayout{{NodeID: "child", NodeType: "system", ParentNodeID: &parent, ParentNodeType: &parentType, Width: 600, Height: 400, Scale: 1}})
	must(err)
	child := "child"
	must(UpsertPlannedEdge(d, &PlannedEdge{ID: "edge", SheetID: sheet.ID, WorkspaceID: "ws", SrcLive: &parent, DstLive: &child, Kind: "CONTAINS"}))
	c, err := CompareSheetStructure(d, "ws", sheet.ID)
	must(err)
	if c.Equivalent {
		t.Fatal("missing infrastructure nesting passed")
	}
	_, err = ApplySheetNesting(d, "ws", sheet.ID, "child", c.Revision, c.Token)
	must(err)
	c, err = CompareSheetStructure(d, "ws", sheet.ID)
	must(err)
	if !c.Equivalent {
		t.Fatalf("hosted structure did not match: %+v", c.Differences)
	}
	// No live dependency row is needed to prove canonical CONTAINS nesting.
	deps, err := GetDependencies(d, "ws")
	must(err)
	if len(deps) != 0 {
		t.Fatal(deps)
	}
}
