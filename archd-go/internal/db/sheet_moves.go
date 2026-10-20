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
		switch {
		case err == sql.ErrNoRows:
			e := node
			e.SheetID = sheetID
			e.ParentSystemID = parent
			if err := insertSheetElement(tx, &e); err != nil {
				return nil, err
			}
			moved = append(moved, e)
		case err != nil:
			return nil, err
		default:
			if _, err := tx.Exec(`UPDATE sheet_elements SET parent_system_id=? WHERE id=?`, parent, existing); err != nil {
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
