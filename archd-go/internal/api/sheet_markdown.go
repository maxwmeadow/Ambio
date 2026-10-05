package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"ambio.local/archd/internal/db"
)

// Sheets as Markdown specs (WORK sheet-markdown). Planning mostly happens in
// text - PR descriptions, AGENTS.md, Spec Kit and Kiro specs - so a sheet can
// leave Ambio as Markdown and come back in as a draft sheet. The export is
// also the import format, so a sheet survives the round trip:
//
//	# Payment flow
//
//	Card payments move out of Orders.
//
//	## Context
//	- system `Shop/Orders`
//	- file `src/orders/checkout.ts`
//
//	## Add
//	- system `Payments` at `src/payments/` - takes card payments
//	  - `charge(amount: Money): Receipt` - charges the card
//
//	## Remove
//	- file `src/legacy/billing.ts`
//
//	## Connections
//	- `Payments` DEPENDS_ON `Email` - receipts
//
// Names in Connections are elements from Add, else live systems (by name or
// "Parent/Child" path), files (by path) or infrastructure (by name).

type sheetSpec struct {
	Name, Purpose string
	Context       []specRef
	Add           []specElement
	Remove        []specRef
	Connections   []specConnection
}

type specRef struct{ Type, Ref string } // system | file | infrastructure

type specElement struct {
	Kind, Name, Path, Intent string
	Members                  []db.PlannedMember
}

type specConnection struct{ From, Kind, To, Note string }

var (
	specAddRe     = regexp.MustCompile("^- ([a-z_]+) `([^`]+)`(?: at `([^`]+)`)?(?: - (.*))?$")
	specMemberRe  = regexp.MustCompile("^\\s+- `([^`]+)`(?: - (.*))?$")
	specRefRe     = regexp.MustCompile("^- (system|file|infrastructure|infra) `([^`]+)`$")
	specConnectRe = regexp.MustCompile("^- `([^`]+)` ([A-Z_]+) `([^`]+)`(?: - (.*))?$")
	specKinds     = map[string]bool{"system": true, "class": true, "file": true, "service": true, "data_store": true, "infra": true}
)

// parseSheetMarkdown reads a spec. Lines it cannot read are returned as
// warnings rather than failing the import: a hand-written spec is allowed to
// carry prose.
func parseSheetMarkdown(text string) (sheetSpec, []string) {
	var spec sheetSpec
	var warnings []string
	var purpose []string
	section := ""
	for number, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := strings.TrimRight(raw, " \t")
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
			continue
		case strings.HasPrefix(trimmed, "## "):
			section = strings.ToLower(strings.TrimSpace(trimmed[3:]))
			continue
		case strings.HasPrefix(trimmed, "# ") && spec.Name == "" && section == "":
			spec.Name = strings.TrimSpace(trimmed[2:])
			continue
		}
		warn := func() { warnings = append(warnings, fmt.Sprintf("line %d not understood: %s", number+1, trimmed)) }
		switch section {
		case "":
			purpose = append(purpose, strings.TrimSpace(strings.TrimPrefix(trimmed, ">")))
		case "context", "remove":
			match := specRefRe.FindStringSubmatch(trimmed)
			if match == nil {
				warn()
				continue
			}
			ref := specRef{Type: match[1], Ref: match[2]}
			if ref.Type == "infra" {
				ref.Type = "infrastructure"
			}
			if section == "context" {
				spec.Context = append(spec.Context, ref)
			} else {
				spec.Remove = append(spec.Remove, ref)
			}
		case "add":
			if match := specMemberRe.FindStringSubmatch(line); match != nil && line != trimmed && len(spec.Add) > 0 {
				last := &spec.Add[len(spec.Add)-1]
				last.Members = append(last.Members, db.PlannedMember{Signature: match[1], Intent: strings.TrimSpace(match[2])})
				continue
			}
			match := specAddRe.FindStringSubmatch(trimmed)
			if match == nil || !specKinds[match[1]] {
				warn()
				continue
			}
			spec.Add = append(spec.Add, specElement{Kind: match[1], Name: match[2], Path: match[3], Intent: strings.TrimSpace(match[4])})
		case "connections":
			match := specConnectRe.FindStringSubmatch(trimmed)
			if match == nil {
				warn()
				continue
			}
			spec.Connections = append(spec.Connections, specConnection{From: match[1], Kind: match[2], To: match[3], Note: strings.TrimSpace(match[4])})
		default:
			warn()
		}
	}
	spec.Purpose = strings.Join(purpose, " ")
	return spec, warnings
}

// liveIndex names live nodes the way a spec does, and finds them again.
type liveIndex struct {
	label  map[string]specRef // node id → how a spec names it
	byName map[string]string  // "system:Shop/Orders", "system:Orders", "file:src/a.ts", "infrastructure:Redis" → id
}

func loadLiveIndex(sqlDB db.Reader, workspaceID string) (*liveIndex, error) {
	index := &liveIndex{label: map[string]specRef{}, byName: map[string]string{}}
	systems, err := db.GetSystems(sqlDB, workspaceID)
	if err != nil {
		return nil, err
	}
	byID := map[string]db.System{}
	for _, system := range systems {
		byID[system.ID] = system
	}
	names := map[string]int{}
	for _, system := range systems {
		names[system.Name]++
	}
	for _, system := range systems {
		path := systemNamePath(byID, system)
		index.label[system.ID] = specRef{Type: "system", Ref: path}
		index.byName["system:"+path] = system.ID
		if names[system.Name] == 1 {
			index.byName["system:"+system.Name] = system.ID
		}
	}
	files, err := db.GetFiles(sqlDB, workspaceID)
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		index.label[file.ID] = specRef{Type: "file", Ref: file.RelPath}
		index.byName["file:"+file.RelPath] = file.ID
	}
	infra, err := db.GetInfraNodes(sqlDB, workspaceID)
	if err != nil {
		return nil, err
	}
	for _, node := range infra {
		index.label[node.ID] = specRef{Type: "infrastructure", Ref: node.Name}
		index.byName["infrastructure:"+node.Name] = node.ID
	}
	return index, nil
}

// find resolves a reference of a known type, or of any type when kind is "".
func (index *liveIndex) find(kind, ref string) (string, string) {
	kinds := []string{kind}
	if kind == "" {
		kinds = []string{"system", "file", "infrastructure"}
	}
	for _, k := range kinds {
		if id, ok := index.byName[k+":"+ref]; ok {
			return k, id
		}
	}
	return "", ""
}

// renderSheetMarkdown writes a sheet as a spec. Rejected and absorbed planned
// elements are left out: they are not part of the plan any more.
func renderSheetMarkdown(sqlDB db.Reader, sheet *db.Sheet) (string, error) {
	index, err := loadLiveIndex(sqlDB, sheet.WorkspaceID)
	if err != nil {
		return "", err
	}
	elements, err := db.GetSheetElements(sqlDB, sheet.ID)
	if err != nil {
		return "", err
	}
	planned, err := db.GetPlannedNodes(sqlDB, sheet.ID)
	if err != nil {
		return "", err
	}
	edges, err := db.GetPlannedEdges(sqlDB, sheet.ID)
	if err != nil {
		return "", err
	}
	removals, err := db.GetSheetRemovals(sqlDB, sheet.WorkspaceID, sheet.ID)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n", sheet.Name)
	if sheet.Purpose != nil && strings.TrimSpace(*sheet.Purpose) != "" {
		fmt.Fprintf(&b, "\n%s\n", strings.TrimSpace(*sheet.Purpose))
	}

	var context []string
	for _, element := range elements {
		if element.Tombstoned() {
			continue
		}
		for _, id := range []*string{element.SystemID, element.FileID, element.InfraID} {
			if id == nil {
				continue
			}
			if ref, ok := index.label[*id]; ok {
				context = append(context, fmt.Sprintf("- %s `%s`", ref.Type, ref.Ref))
			}
		}
	}
	if len(context) > 0 {
		b.WriteString("\n## Context\n" + strings.Join(context, "\n") + "\n")
	}

	plannedName := map[string]string{}
	var add []string
	for _, node := range planned {
		if node.ApprovalStatus == "rejected" || node.Status == "flattened" {
			continue
		}
		plannedName[node.ID] = node.Name
		line := fmt.Sprintf("- %s `%s`", node.Kind, node.Name)
		if node.DeclaredPath != "" {
			line += fmt.Sprintf(" at `%s`", node.DeclaredPath)
		}
		if note := strings.Join(strings.Fields(node.Notes), " "); note != "" {
			line += " - " + note
		}
		var members []db.PlannedMember
		_ = json.Unmarshal(node.Members, &members)
		for _, member := range members {
			line += fmt.Sprintf("\n  - `%s`", member.Signature)
			if member.Intent != "" {
				line += " - " + member.Intent
			}
		}
		add = append(add, line)
	}
	if len(add) > 0 {
		b.WriteString("\n## Add\n" + strings.Join(add, "\n") + "\n")
	}

	if len(removals) > 0 {
		b.WriteString("\n## Remove\n")
		for _, removal := range removals {
			ref, ok := index.label[removal.NodeID]
			if !ok {
				ref = specRef{Type: removal.NodeType, Ref: removal.Label}
				if ref.Type == "infra" {
					ref.Type = "infrastructure"
				}
			}
			fmt.Fprintf(&b, "- %s `%s`\n", ref.Type, ref.Ref)
		}
	}

	var connections []string
	end := func(planned, live *string) string {
		if planned != nil {
			return plannedName[*planned]
		}
		if live != nil {
			return index.label[*live].Ref
		}
		return ""
	}
	for _, edge := range edges {
		from, to := end(edge.SrcPlanned, edge.SrcLive), end(edge.DstPlanned, edge.DstLive)
		if from == "" || to == "" {
			continue
		}
		line := fmt.Sprintf("- `%s` %s `%s`", from, edge.Kind, to)
		if edge.Note != "" {
			line += " - " + edge.Note
		}
		connections = append(connections, line)
	}
	if len(connections) > 0 {
		b.WriteString("\n## Connections\n" + strings.Join(connections, "\n") + "\n")
	}
	return b.String(), nil
}

// importSheetMarkdown creates a draft sheet from a spec. An agent's import
// arrives as proposals for the person to confirm, like anything else it draws.
func (s *Server) importSheetMarkdown(sqlDB *sql.DB, workspaceID, text, createdBy string) (*db.Sheet, []string, error) {
	spec, warnings := parseSheetMarkdown(text)
	if createdBy != "agent" {
		createdBy = "user"
	}
	name := strings.TrimSpace(spec.Name)
	if name == "" {
		name = "Imported spec"
	}
	for attempt := 2; ; attempt++ {
		taken, err := db.SheetNameTaken(sqlDB, workspaceID, name, "")
		if err != nil {
			return nil, nil, err
		}
		if !taken {
			break
		}
		name = strings.TrimSpace(spec.Name) + " (" + strconv.Itoa(attempt) + ")"
		if spec.Name == "" {
			name = "Imported spec (" + strconv.Itoa(attempt) + ")"
		}
	}
	index, err := loadLiveIndex(sqlDB, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	var purpose *string
	if spec.Purpose != "" {
		purpose = &spec.Purpose
	}
	sheet := &db.Sheet{WorkspaceID: workspaceID, Name: name, Purpose: purpose, CreatedBy: createdBy}
	if err := db.CreateSheet(sqlDB, sheet); err != nil {
		return nil, nil, err
	}

	slot := 0
	next := func() (float64, float64) {
		x, y := 40+float64(slot%4)*260, 40+float64(slot/4)*180
		slot++
		return x, y
	}
	for _, ref := range spec.Context {
		kind, id := index.find(ref.Type, ref.Ref)
		if id == "" {
			warnings = append(warnings, fmt.Sprintf("%s %q is not on the map; left out of the context", ref.Type, ref.Ref))
			continue
		}
		in := sheetElementInput{AddedBy: createdBy}
		switch kind {
		case "system":
			in.SystemID = &id
		case "file":
			in.FileID = &id
		default:
			in.InfraID = &id
		}
		x, y := next()
		in.X, in.Y = &x, &y
		element, _ := resolveElement(sqlDB, sheet.ID, in)
		if err := db.AddSheetElement(sqlDB, element); err != nil {
			return nil, nil, err
		}
	}

	plannedID := map[string]string{}
	for _, element := range spec.Add {
		members, _ := json.Marshal(element.Members)
		if element.Members == nil {
			members = []byte("[]")
		}
		x, y := next()
		node := &db.PlannedNode{
			SheetID: sheet.ID, WorkspaceID: workspaceID, Kind: element.Kind, Name: element.Name,
			DeclaredPath: element.Path, Notes: element.Intent, Members: members, CreatedBy: createdBy,
			PositionX: x, PositionY: y,
		}
		if err := db.UpsertPlannedNode(sqlDB, node); err != nil {
			return nil, nil, err
		}
		plannedID[element.Name] = node.ID
	}

	for _, ref := range spec.Remove {
		_, id := index.find(ref.Type, ref.Ref)
		if id == "" {
			warnings = append(warnings, fmt.Sprintf("%s %q is not on the map; nothing to remove", ref.Type, ref.Ref))
			continue
		}
		if _, err := db.ProposeSheetRemoval(sqlDB, workspaceID, sheet.ID, id, createdBy); err != nil {
			return nil, nil, err
		}
	}

	endpoint := func(name string) (planned, live *string) {
		if id, ok := plannedID[name]; ok {
			return &id, nil
		}
		if _, id := index.find("", name); id != "" {
			return nil, &id
		}
		return nil, nil
	}
	for _, connection := range spec.Connections {
		srcPlanned, srcLive := endpoint(connection.From)
		dstPlanned, dstLive := endpoint(connection.To)
		if (srcPlanned == nil && srcLive == nil) || (dstPlanned == nil && dstLive == nil) {
			warnings = append(warnings, fmt.Sprintf("connection %s → %s names something that is neither added nor on the map", connection.From, connection.To))
			continue
		}
		if err := db.UpsertPlannedEdge(sqlDB, &db.PlannedEdge{
			SheetID: sheet.ID, WorkspaceID: workspaceID, Kind: connection.Kind,
			SrcPlanned: srcPlanned, SrcLive: srcLive, DstPlanned: dstPlanned, DstLive: dstLive, Note: connection.Note,
		}); err != nil {
			return nil, nil, err
		}
	}
	if err := db.BackfillSheetLayouts(sqlDB); err != nil {
		return nil, nil, err
	}
	if fresh, err := db.GetSheet(sqlDB, sheet.ID); err == nil && fresh != nil {
		sheet = fresh
	}
	s.broadcastPatch("sheet:upserted", sheet)
	if warnings == nil {
		warnings = []string{}
	}
	return sheet, warnings, nil
}
