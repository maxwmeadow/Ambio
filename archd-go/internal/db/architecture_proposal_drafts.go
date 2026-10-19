package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
)

// DraftSystem is deliberately small: an agent only needs to name a boundary,
// link it to a parent key, and list repository-relative files.
type DraftSystem struct {
	SystemKey   string   `json:"systemKey"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	ParentKey   string   `json:"parentKey"`
	RootID      string   `json:"rootId"`
	Files       []string `json:"files"`
}

type ArchitectureProposalDraft struct {
	ID          string        `json:"sessionId"`
	WorkspaceID string        `json:"workspaceId"`
	Rationale   string        `json:"rationale"`
	Status      string        `json:"status"`
	ProposalID  string        `json:"proposalId,omitempty"`
	ChunkCount  int           `json:"chunkCount"`
	ChunkIDs    []string      `json:"chunkIds"`
	Systems     []DraftSystem `json:"systems"`
	UpdatedAt   int64         `json:"updatedAt"`
	// Skipped is set only on the reply to an added chunk: the files of that
	// chunk that were left out, and why.
	Skipped []SkippedDraftFile `json:"skipped,omitempty"`
}

// DraftFileNotIndexed is the reason for a path with no row in files. The API
// layer says more, since it knows which file types the indexer admits.
const DraftFileNotIndexed = "not indexed"

type SkippedDraftFile struct {
	SystemKey string `json:"systemKey"`
	Path      string `json:"path"`
	Reason    string `json:"reason"`
}

func BeginArchitectureProposalDraft(database *sql.DB, workspaceID, rationale string) (*ArchitectureProposalDraft, error) {
	if workspaceID == "" {
		return nil, fmt.Errorf("workspace id is required")
	}
	var exists int
	if err := database.QueryRow(`SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?)`, workspaceID).Scan(&exists); err != nil {
		return nil, err
	}
	if exists == 0 {
		return nil, fmt.Errorf("workspace %s does not exist", workspaceID)
	}
	id, now := uuid.NewString(), time.Now().UnixMilli()
	_, err := database.Exec(`INSERT INTO architecture_proposal_drafts(id,workspace_id,rationale,created_at,updated_at) VALUES(?,?,?,?,?)`, id, workspaceID, rationale, now, now)
	if err != nil {
		return nil, err
	}
	return &ArchitectureProposalDraft{ID: id, WorkspaceID: workspaceID, Rationale: rationale, Status: "open", Systems: []DraftSystem{}, UpdatedAt: now}, nil
}

func GetArchitectureProposalDraft(database *sql.DB, id, workspaceID string) (*ArchitectureProposalDraft, error) {
	draft := &ArchitectureProposalDraft{ID: id, WorkspaceID: workspaceID, Systems: []DraftSystem{}, ChunkIDs: []string{}}
	err := database.QueryRow(`SELECT rationale,status,proposal_id,updated_at FROM architecture_proposal_drafts WHERE id=? AND workspace_id=?`, id, workspaceID).
		Scan(&draft.Rationale, &draft.Status, &draft.ProposalID, &draft.UpdatedAt)
	if err != nil {
		return nil, err
	}
	rows, err := database.Query(`SELECT chunk_id,systems_json FROM architecture_proposal_draft_chunks WHERE draft_id=? ORDER BY ordinal`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw, chunkID string
		if err := rows.Scan(&chunkID, &raw); err != nil {
			return nil, err
		}
		var systems []DraftSystem
		if err := json.Unmarshal([]byte(raw), &systems); err != nil {
			return nil, err
		}
		draft.Systems = append(draft.Systems, systems...)
		draft.ChunkIDs = append(draft.ChunkIDs, chunkID)
		draft.ChunkCount++
	}
	return draft, rows.Err()
}

func ListOpenArchitectureProposalDrafts(database *sql.DB, workspaceID string) ([]ArchitectureProposalDraft, error) {
	rows, err := database.Query(`SELECT id FROM architecture_proposal_drafts WHERE workspace_id=? AND status='open' ORDER BY updated_at DESC`, workspaceID)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	drafts := make([]ArchitectureProposalDraft, 0, len(ids))
	for _, id := range ids {
		draft, err := GetArchitectureProposalDraft(database, id, workspaceID)
		if err != nil {
			return nil, err
		}
		drafts = append(drafts, *draft)
	}
	return drafts, nil
}

func validateDraftSystem(system DraftSystem) error {
	if strings.TrimSpace(system.SystemKey) == "" || strings.TrimSpace(system.Name) == "" {
		return fmt.Errorf("each system needs a systemKey and name")
	}
	for _, file := range system.Files {
		clean := path.Clean(strings.ReplaceAll(file, "\\", "/"))
		if file == "" || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || strings.Contains(file, ":") {
			return fmt.Errorf("invalid relative file path %q", file)
		}
	}
	return nil
}

// Each chunk is atomic and idempotent. A changed retry gets a conflict rather
// than silently replacing part of a map the agent may already have built on.
//
// A file that cannot be placed does not fail the chunk: it is left out and
// returned in Skipped with the reason, so one stylesheet in a batch of forty
// source files costs the agent a note, not a rebuilt batch.
func AddArchitectureProposalDraftChunk(database *sql.DB, id, workspaceID, chunkID string, systems []DraftSystem) (*ArchitectureProposalDraft, error) {
	if strings.TrimSpace(chunkID) == "" {
		return nil, fmt.Errorf("chunkId is required")
	}
	if len(systems) == 0 {
		return nil, fmt.Errorf("systems are required")
	}
	for _, system := range systems {
		if err := validateDraftSystem(system); err != nil {
			return nil, err
		}
	}
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	var status string
	if err := tx.QueryRow(`SELECT status FROM architecture_proposal_drafts WHERE id=? AND workspace_id=?`, id, workspaceID).Scan(&status); err != nil {
		return nil, err
	}
	rows, err := tx.Query(`SELECT chunk_id,systems_json FROM architecture_proposal_draft_chunks WHERE draft_id=?`, id)
	if err != nil {
		return nil, err
	}
	// What the other chunks already hold. This chunk's own earlier copy is set
	// aside so a retry is compared with it, not rejected as its own duplicate.
	keys, fileOwner := map[string]bool{}, map[string]string{}
	previous, retried := "", false
	for rows.Next() {
		var savedID, saved string
		if err := rows.Scan(&savedID, &saved); err != nil {
			rows.Close()
			return nil, err
		}
		if savedID == chunkID {
			previous, retried = saved, true
			continue
		}
		var previousSystems []DraftSystem
		if err := json.Unmarshal([]byte(saved), &previousSystems); err != nil {
			rows.Close()
			return nil, err
		}
		for _, system := range previousSystems {
			keys[system.SystemKey] = true
			for _, file := range system.Files {
				fileOwner[system.RootID+":"+file] = system.Name
			}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	// Keep the files that are indexed and not yet placed; note the rest.
	placed := make([]DraftSystem, len(systems))
	skipped := []SkippedDraftFile{}
	for index, system := range systems {
		placed[index] = system
		if system.Files == nil {
			continue
		}
		kept := make([]string, 0, len(system.Files))
		for _, file := range system.Files {
			var matches int
			var language sql.NullString
			if err := tx.QueryRow(`SELECT COUNT(*),MIN(f.language) FROM files f JOIN roots r ON r.id=f.root_id WHERE r.workspace_id=? AND f.rel_path=? AND (?='' OR r.id=?)`, workspaceID, file, system.RootID, system.RootID).Scan(&matches, &language); err != nil {
				return nil, err
			}
			fileKey := system.RootID + ":" + file
			reason := ""
			switch owner, taken := fileOwner[fileKey]; {
			case matches == 0:
				reason = DraftFileNotIndexed
			case matches > 1:
				reason = "ambiguous across roots; set rootId on the system and assign it again"
			case language.String == "markdown" || language.String == "text":
				reason = "documentation belongs in Documents, not in a system"
			case taken:
				reason = fmt.Sprintf("already placed in %q in this session", owner)
			}
			if reason != "" {
				skipped = append(skipped, SkippedDraftFile{SystemKey: system.SystemKey, Path: file, Reason: reason})
				continue
			}
			fileOwner[fileKey] = system.Name
			kept = append(kept, file)
		}
		placed[index].Files = kept
	}
	raw, err := json.Marshal(placed)
	if err != nil {
		return nil, err
	}
	finish := func() (*ArchitectureProposalDraft, error) {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		draft, err := GetArchitectureProposalDraft(database, id, workspaceID)
		if err != nil {
			return nil, err
		}
		draft.Skipped = skipped
		return draft, nil
	}
	if retried {
		if previous != string(raw) {
			return nil, fmt.Errorf("chunkId already exists with different systems")
		}
		return finish()
	}
	if status != "open" {
		return nil, fmt.Errorf("draft is already %s", status)
	}
	for _, system := range placed {
		if keys[system.SystemKey] {
			return nil, fmt.Errorf("duplicate systemKey %q", system.SystemKey)
		}
		keys[system.SystemKey] = true
	}
	var ordinal int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM architecture_proposal_draft_chunks WHERE draft_id=?`, id).Scan(&ordinal); err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	if _, err := tx.Exec(`INSERT INTO architecture_proposal_draft_chunks(draft_id,chunk_id,ordinal,systems_json,created_at) VALUES(?,?,?,?,?)`, id, chunkID, ordinal, string(raw), now); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE architecture_proposal_drafts SET updated_at=? WHERE id=?`, now, id); err != nil {
		return nil, err
	}
	return finish()
}

func CommitArchitectureProposalDraft(database *sql.DB, id, workspaceID string) (*ArchitectureProposal, error) {
	draft, err := GetArchitectureProposalDraft(database, id, workspaceID)
	if err != nil {
		return nil, err
	}
	if draft.Status == "aborted" {
		return nil, fmt.Errorf("draft is already aborted")
	}
	if draft.Status == "committed" {
		return GetArchitectureProposal(database, draft.ProposalID, workspaceID, false)
	}
	if len(draft.Systems) == 0 {
		return nil, fmt.Errorf("draft needs at least one system")
	}
	byKey := make(map[string]DraftSystem, len(draft.Systems))
	for _, system := range draft.Systems {
		byKey[system.SystemKey] = system
	}
	depths := map[string]int{}
	visiting := map[string]bool{}
	var depthOf func(string) (int, error)
	depthOf = func(key string) (int, error) {
		if depth, ok := depths[key]; ok {
			return depth, nil
		}
		if visiting[key] {
			return 0, fmt.Errorf("hierarchy cycle at %s", key)
		}
		visiting[key] = true
		system := byKey[key]
		depth := 0
		if system.ParentKey != "" {
			if _, ok := byKey[system.ParentKey]; !ok {
				return 0, fmt.Errorf("proposed parent %s does not exist", system.ParentKey)
			}
			parentDepth, err := depthOf(system.ParentKey)
			if err != nil {
				return 0, err
			}
			depth = parentDepth + 1
		}
		visiting[key] = false
		depths[key] = depth
		return depth, nil
	}
	round := ArchitectureProposalRound{Rationale: draft.Rationale, Coverage: "no_change", Systems: []ArchitectureProposalSystem{}, Memberships: []ArchitectureProposalMembership{}}
	for _, system := range draft.Systems {
		depth, err := depthOf(system.SystemKey)
		if err != nil {
			return nil, err
		}
		parentType := "scope"
		if system.ParentKey != "" {
			parentType = "proposed_system"
		}
		round.Systems = append(round.Systems, ArchitectureProposalSystem{SystemKey: system.SystemKey, Name: system.Name, Description: system.Description, ParentRefType: parentType, ParentRefID: system.ParentKey, Depth: depth})
		for _, file := range system.Files {
			round.Memberships = append(round.Memberships, ArchitectureProposalMembership{RootID: system.RootID, FilePath: file, TargetSystemKey: system.SystemKey, Disposition: "assign"})
		}
	}
	if len(round.Memberships) > 0 {
		round.Coverage = "complete"
	}
	// A system made only of files Ambio does not index had them skipped as
	// each chunk was saved; it is left out rather than shown empty in review.
	if err := dropEmptySystems(&round); err != nil {
		return nil, err
	}
	// A proposal id derived from the draft makes commit retryable if the daemon
	// exits after creating the proposal but before updating the draft status.
	proposal, err := CreateArchitectureProposal(database, ArchitectureProposal{ID: id, WorkspaceID: workspaceID, ParentScopeType: "workspace", CreatedBy: "agent", Round: round})
	if err != nil {
		if existing, lookupErr := GetArchitectureProposal(database, id, workspaceID, false); lookupErr == nil {
			proposal = existing
		} else {
			return nil, err
		}
	}
	if _, err := database.Exec(`UPDATE architecture_proposal_drafts SET status='committed',proposal_id=?,updated_at=? WHERE id=? AND workspace_id=? AND status='open'`, proposal.ID, time.Now().UnixMilli(), id, workspaceID); err != nil {
		return nil, err
	}
	return proposal, nil
}

func AbortArchitectureProposalDraft(database *sql.DB, id, workspaceID string) error {
	tx, err := database.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	result, err := tx.Exec(`UPDATE architecture_proposal_drafts SET status='aborted',updated_at=? WHERE id=? AND workspace_id=? AND status='open'`, time.Now().UnixMilli(), id, workspaceID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed == 0 {
		return fmt.Errorf("draft is missing or already closed")
	}
	if _, err := tx.Exec(`DELETE FROM architecture_proposal_draft_chunks WHERE draft_id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}
