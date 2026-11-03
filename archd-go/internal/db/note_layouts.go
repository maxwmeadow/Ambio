package db

import (
	"database/sql"
	"fmt"
	"strings"
)

// Notes use the existing layout tables and validators, not a second placement
// model. Rebuild only old CHECK constraints; preserve every existing row/index.
func migrateNoteLayouts(database *sql.DB) error {
	tx, err := database.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND (sql LIKE '%floor_layouts%' OR sql LIKE '%sheet_layouts%')`)
	if err != nil {
		return err
	}
	type trigger struct{ name, statement string }
	var triggers []trigger
	for rows.Next() {
		var item trigger
		if err := rows.Scan(&item.name, &item.statement); err != nil {
			rows.Close()
			return err
		}
		triggers = append(triggers, item)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, item := range triggers {
		if _, err := tx.Exec(`DROP TRIGGER "` + strings.ReplaceAll(item.name, `"`, `""`) + `"`); err != nil {
			return err
		}
	}
	for _, table := range []string{"floor_layouts", "sheet_layouts"} {
		var definition string
		if err := tx.QueryRow(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&definition); err != nil {
			return err
		}
		if strings.Contains(definition, "'note'") {
			continue
		}
		next := table + "_notes_upgrade"
		definition = strings.Replace(definition, table, next, 1)
		definition = strings.ReplaceAll(definition, "'system','file','infra'", "'system','file','infra','note'")
		for _, statement := range []string{definition, "INSERT INTO " + next + " SELECT * FROM " + table, "DROP TABLE " + table, "ALTER TABLE " + next + " RENAME TO " + table} {
			if _, err := tx.Exec(statement); err != nil {
				return fmt.Errorf("upgrade note layouts: %w", err)
			}
		}
	}
	for _, item := range triggers {
		if _, err := tx.Exec(item.statement); err != nil {
			return err
		}
	}
	_, err = tx.Exec(`
 CREATE INDEX IF NOT EXISTS floor_layouts_parent ON floor_layouts(workspace_id,parent_node_type,parent_node_id);
 CREATE INDEX IF NOT EXISTS sheet_layouts_parent ON sheet_layouts(sheet_id,parent_node_type,parent_node_id);
 INSERT OR IGNORE INTO floor_layouts(workspace_id,node_id,node_type,containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at)
 SELECT workspace_id,'note:'||id,'note','root',COALESCE(position_x,40),COALESCE(position_y,40),width,height,1,1,created_at FROM annotations WHERE kind='note' AND sheet_id IS NULL;
 INSERT OR IGNORE INTO sheet_layouts(sheet_id,workspace_id,node_id,node_type,containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at)
 SELECT sheet_id,workspace_id,'note:'||id,'note','root',COALESCE(position_x,40),COALESCE(position_y,40),width,height,1,1,created_at FROM annotations WHERE kind='note' AND sheet_id IS NOT NULL;
 CREATE TRIGGER IF NOT EXISTS annotation_insert_note_layout AFTER INSERT ON annotations WHEN NEW.kind='note' BEGIN
  INSERT INTO floor_layouts(workspace_id,node_id,node_type,containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at)
  SELECT NEW.workspace_id,'note:'||NEW.id,'note','root',COALESCE(NEW.position_x,40),COALESCE(NEW.position_y,40),NEW.width,NEW.height,1,1,NEW.created_at WHERE NEW.sheet_id IS NULL;
  INSERT INTO sheet_layouts(sheet_id,workspace_id,node_id,node_type,containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at)
  SELECT NEW.sheet_id,NEW.workspace_id,'note:'||NEW.id,'note','root',COALESCE(NEW.position_x,40),COALESCE(NEW.position_y,40),NEW.width,NEW.height,1,1,NEW.created_at WHERE NEW.sheet_id IS NOT NULL;
 END;
 CREATE TRIGGER IF NOT EXISTS annotation_delete_note_layout AFTER DELETE ON annotations BEGIN
  DELETE FROM floor_layouts WHERE workspace_id=OLD.workspace_id AND node_type='note' AND node_id='note:'||OLD.id;
  DELETE FROM sheet_layouts WHERE workspace_id=OLD.workspace_id AND node_type='note' AND node_id='note:'||OLD.id;
 END;
 `)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// Annotation text has its own edit revision. Spatial transactions remain the
// same atomic layout batches used by every other canvas node.
func GetNoteLayout(database Reader, a Annotation) (*FloorLayout, error) {
	var row FloorLayout
	query := `SELECT workspace_id,node_id,node_type,parent_node_id,parent_node_type,containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at FROM floor_layouts WHERE workspace_id=? AND node_type='note' AND node_id=?`
	args := []any{a.WorkspaceID, "note:" + a.ID}
	if a.SheetID != nil {
		query = strings.Replace(query, "FROM floor_layouts", "FROM sheet_layouts", 1) + " AND sheet_id=?"
		args = append(args, *a.SheetID)
	}
	err := database.QueryRow(query, args...).Scan(&row.WorkspaceID, &row.NodeID, &row.NodeType, &row.ParentNodeID, &row.ParentNodeType, &row.ContainmentKind, &row.PositionX, &row.PositionY, &row.Width, &row.Height, &row.Scale, &row.InteriorScale, &row.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}
