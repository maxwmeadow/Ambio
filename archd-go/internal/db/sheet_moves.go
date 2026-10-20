package db

import (
	"database/sql"
	"fmt"
	"strings"
)

// ProposeSheetMove records on a sheet that live nodes should belong to parent:
// a live system or platform, a planned container on this sheet ("planned:<id>"),
// or nil for the top level. It is how an agent proposes moving a file or
// system into another boundary - for example into a system it just planned -
// without saying where on the canvas: each node gets the new parent and no
// geometry, so the canvas places it inside the parent, and compare and the
// build plan read the move from the element's parent.
//
// A node already on the sheet is updated rather than added twice, and any
// layout the sheet held for it is dropped, since that layout named its old
// place.
func ProposeSheetMove(sqlDB *sql.DB, sheetID, workspaceID string, nodes []SheetElement, parent *string) ([]SheetElement, error) {
	if parent != nil && *parent == "" {
		parent = nil
	}
	tx, err := sqlDB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	if parent != nil {
		if err := checkSheetParent(tx, sheetID, workspaceID, *parent); err != nil {
			return nil, err
		}
	}

	moved := make([]SheetElement, 0, len(nodes))
	for _, node := range nodes {
		nodeID := refValue(node.SystemID)
		if nodeID == "" {
			nodeID = refValue(node.FileID)
		}
		if nodeID == "" {
			nodeID = refValue(node.InfraID)
		}
		if nodeID == "" {
			return nil, fmt.Errorf("only files, systems and infrastructure can be moved")
		}
		if parent != nil {
			if err := checkMoveCycle(tx, sheetID, nodeID, *parent); err != nil {
				return nil, err
			}
		}
		var existing string
		err := tx.QueryRow(`
			SELECT id FROM sheet_elements
			WHERE sheet_id=? AND (system_id=? OR file_id=? OR infra_id=?)
			ORDER BY rowid LIMIT 1`, sheetID, nodeID, nodeID, nodeID).Scan(&existing)
		approval := "approved"
		if node.AddedBy == "agent" {
			approval = "pending"
		}
		switch {
		case err == sql.ErrNoRows:
			e := node
			e.SheetID = sheetID
			e.ParentSystemID = parent
			e.ApprovalStatus = approval
			if err := insertSheetElement(tx, &e); err != nil {
				return nil, err
			}
			moved = append(moved, e)
		case err != nil:
			return nil, err
		default:
			if _, err := tx.Exec(`UPDATE sheet_elements SET parent_system_id=?, approval_status=? WHERE id=?`, parent, approval, existing); err != nil {
				return nil, err
			}
			e := node
			e.ID = existing
			e.SheetID = sheetID
			e.ParentSystemID = parent
			moved = append(moved, e)
		}
		if _, err := tx.Exec(`DELETE FROM sheet_layouts WHERE sheet_id=? AND node_id=?`, sheetID, nodeID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	_ = TouchSheet(sqlDB, sheetID)
	elements, err := GetSheetElements(sqlDB, sheetID)
	if err != nil {
		return moved, nil
	}
	// Return the stored rows, so callers see labels and the full element.
	byID := map[string]SheetElement{}
	for _, e := range elements {
		byID[e.ID] = e
	}
	for i := range moved {
		if stored, ok := byID[moved[i].ID]; ok {
			moved[i] = stored
		}
	}
	return moved, nil
}

func checkSheetParent(tx *sql.Tx, sheetID, workspaceID, parent string) error {
	parentType := "system"
	isInfra, err := sheetParentIsInfra(tx, sheetID, parent)
	if err != nil {
		return err
	}
	if isInfra {
		parentType = "infra"
	}
	ok, err := sheetLayoutParentExists(tx, sheetID, workspaceID, parent, parentType)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%s is not a system or platform in this project or a planned system on this sheet", parent)
	}
	return nil
}

// DecideSheetMove records the human's decision on a proposed move. Rejecting
// puts the node back under its parent on the Floor, so the sheet no longer
// proposes moving it.
func DecideSheetMove(sqlDB *sql.DB, sheetID, elementID, decision string) error {
	if decision != "approved" && decision != "rejected" {
		return fmt.Errorf("decision must be approved or rejected")
	}
	var systemID, fileID sql.NullString
	var workspaceID string
	if err := sqlDB.QueryRow(`
		SELECT e.system_id, e.file_id, s.workspace_id FROM sheet_elements e JOIN sheets s ON s.id=e.sheet_id
		WHERE e.id=? AND e.sheet_id=? AND e.approval_status<>''`, elementID, sheetID).Scan(&systemID, &fileID, &workspaceID); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("no proposed move %s on this sheet", elementID)
		}
		return err
	}
	if decision == "approved" {
		_, err := sqlDB.Exec(`UPDATE sheet_elements SET approval_status='approved' WHERE id=?`, elementID)
		if err == nil {
			_ = TouchSheet(sqlDB, sheetID)
		}
		return err
	}
	nodeID := systemID.String
	if nodeID == "" {
		nodeID = fileID.String
	}
	// Where the Floor has it: its layout parent, else the semantic one.
	var floorParent sql.NullString
	err := sqlDB.QueryRow(`SELECT parent_node_id FROM floor_layouts WHERE workspace_id=? AND node_id=?`, workspaceID, nodeID).Scan(&floorParent)
	if err == sql.ErrNoRows {
		if systemID.Valid {
			err = sqlDB.QueryRow(`SELECT parent_id FROM systems WHERE id=?`, nodeID).Scan(&floorParent)
		} else {
			err = sqlDB.QueryRow(`SELECT system_id FROM files WHERE id=?`, nodeID).Scan(&floorParent)
		}
	}
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	var parent *string
	if floorParent.Valid && floorParent.String != "" {
		parent = &floorParent.String
	}
	if _, err := sqlDB.Exec(`UPDATE sheet_elements SET parent_system_id=?, approval_status='rejected' WHERE id=?`, parent, elementID); err != nil {
		return err
	}
	if _, err := sqlDB.Exec(`DELETE FROM sheet_layouts WHERE sheet_id=? AND node_id=?`, sheetID, nodeID); err != nil {
		return err
	}
	return TouchSheet(sqlDB, sheetID)
}

func sheetParentIsInfra(tx *sql.Tx, sheetID, parentID string) (bool, error) {
	var n int
	if strings.HasPrefix(parentID, "planned:") {
		err := tx.QueryRow(`SELECT COUNT(*) FROM planned_nodes WHERE id=? AND sheet_id=? AND kind='infra'`,
			strings.TrimPrefix(parentID, "planned:"), sheetID).Scan(&n)
		return n > 0, err
	}
	err := tx.QueryRow(`SELECT COUNT(*) FROM infra_nodes WHERE id=?`, parentID).Scan(&n)
	return n > 0, err
}

// checkMoveCycle refuses a move that would put a system inside itself or one
// of its own descendants, following live parents and planned ones on the sheet.
func checkMoveCycle(tx *sql.Tx, sheetID, nodeID, parentID string) error {
	current := parentID
	for steps := 0; current != "" && steps < 256; steps++ {
		if current == nodeID {
			return fmt.Errorf("cannot move %s inside itself", nodeID)
		}
		var next sql.NullString
		var err error
		if strings.HasPrefix(current, "planned:") {
			err = tx.QueryRow(`SELECT parent_system_id FROM planned_nodes WHERE id=? AND sheet_id=?`,
				strings.TrimPrefix(current, "planned:"), sheetID).Scan(&next)
		} else {
			// The sheet's own opinion of a parent wins over the Floor's.
			err = tx.QueryRow(`SELECT parent_system_id FROM sheet_elements WHERE sheet_id=? AND system_id=? LIMIT 1`,
				sheetID, current).Scan(&next)
			if err == sql.ErrNoRows {
				err = tx.QueryRow(`SELECT parent_id FROM systems WHERE id=?`, current).Scan(&next)
			}
		}
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		current = next.String
	}
	return nil
}
