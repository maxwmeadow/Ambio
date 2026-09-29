// Infra layer HTTP endpoints (INFRA_LAYER_PLAN.md Phase I1).
//
//	GET  /api/registry/services              - resolved service registry (categories + services)
//	GET  /api/infra?workspace=               - list infra nodes + their edges
//	POST /api/infra                          - create/upsert an infra node
//	PUT  /api/infra/:id                      - update (rename, reskin, config, status)
//	DELETE /api/infra/:id?workspace=         - delete node (edges cleaned by trigger)
//	POST /api/infra/:id/position             - move on canvas {x, y, workspaceId}
//	POST /api/infra/connect                  - create a typed file/system→infra edge
//	PUT  /api/infra/edge/:id                 - decide a proposed edge {status}
//	DELETE /api/infra/edge/:id?workspace=    - remove an infra edge
//	POST /api/infra/:id/contents             - record contract items {items:[{kind,name,detail,evidence}]}
//	DELETE /api/infra/contents/:id?workspace= - remove a contract item
//	POST /api/infra/requirements             - record requirements {items:[{kind,name,infraId,evidence,present}]}
package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/indexer"
	"axiom.local/archd/internal/infradetect"
	"axiom.local/archd/internal/registry"
)

// reloadRegistry re-resolves the layered registry with all known workspace
// roots so <root>/.axiom/services/ definitions are picked up.
func (s *Server) reloadRegistry() {
	s.mu.RLock()
	paths := make([]string, 0, len(s.roots))
	for _, r := range s.roots {
		paths = append(paths, r.Path)
	}
	s.mu.RUnlock()
	loaded := registry.Load(paths)
	s.mu.Lock()
	s.registry = loaded
	s.mu.Unlock()
}

func (s *Server) currentRegistry() *registry.Registry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.registry
}

func (s *Server) handleRegistryServices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	jsonOK(w, map[string]any{
		"categories": registry.CategoryList(),
		"services":   s.currentRegistry().All(),
	})
}

// applyService fills a node's category/provider/subtype from its registry
// entry so callers only need to send a service id. Explicit fields win when
// no service is set (unassigned generic nodes).
func (s *Server) applyService(n *db.InfraNode) error {
	services := s.currentRegistry()
	if n.Service != "" {
		svc, ok := services.Get(n.Service)
		if !ok {
			return fmt.Errorf("unknown service %q - see GET /api/registry/services", n.Service)
		}
		n.Category = svc.Category
		n.Provider = svc.Provider
		if n.Subtype == "" {
			n.Subtype = svc.Subtype
		}
		if n.Name == "" {
			n.Name = svc.Name
		}
		return nil
	}
	if _, ok := registry.Categories[n.Category]; n.Category != "" && !ok {
		return fmt.Errorf("unknown category %q", n.Category)
	}
	return nil
}

func (s *Server) handleInfra(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		s.writeInfraList(w, sqlDB, workspaceID)

	case http.MethodPost:
		var n db.InfraNode
		if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		if err := s.applyService(&n); err != nil {
			jsonError(w, err.Error(), 400)
			return
		}
		if n.Name == "" {
			jsonError(w, "name is required (or send a service id to inherit its name)", 400)
			return
		}
		sqlDB, err := s.dbFor(n.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpsertInfraNode(sqlDB, &n); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("infra:upserted", n)
		jsonOK(w, n)

	default:
		http.NotFound(w, r)
	}
}

// handleInfraByID routes /api/infra/:id and /api/infra/:id/position.
func (s *Server) handleInfraByID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/infra/")
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}
	if id == "" {
		http.NotFound(w, r)
		return
	}

	switch {
	case r.Method == http.MethodPut && sub == "":
		var body struct {
			WorkspaceID string          `json:"workspaceId"`
			Name        *string         `json:"name"`
			Service     *string         `json:"service"` // reskin: re-resolves category/provider
			Subtype     *string         `json:"subtype"`
			Status      *string         `json:"status"` // 'proposed'|'confirmed'|'dismissed'
			Config      json.RawMessage `json:"config"`
			Implementations json.RawMessage `json:"implementations"`
			Policies        json.RawMessage `json:"policies"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		n, err := db.GetInfraNode(sqlDB, id)
		if err != nil || n == nil {
			jsonError(w, "infra node not found", 404)
			return
		}
		if body.Name != nil {
			n.Name = *body.Name
		}
		if body.Service != nil {
			n.Service = *body.Service
			n.Subtype = "" // re-derive from the new service
			if err := s.applyService(n); err != nil {
				jsonError(w, err.Error(), 400)
				return
			}
		}
		if body.Subtype != nil {
			n.Subtype = *body.Subtype
		}
		statusChanged := false
		if body.Status != nil {
			if !validDecision(*body.Status) {
				jsonError(w, "status must be proposed|confirmed|dismissed", 400)
				return
			}
			statusChanged = n.Status != *body.Status
			n.Status = *body.Status
		}
		if body.Config != nil {
			n.Config = body.Config
		}
		if body.Implementations != nil {
			if err := validateImplementations(body.Implementations); err != nil {
				jsonError(w, err.Error(), 400)
				return
			}
			n.Implementations = body.Implementations
		}
		if body.Policies != nil {
			n.Policies = body.Policies
		}
		if err := db.UpsertInfraNode(sqlDB, n); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		if statusChanged && n.Status != "proposed" {
			// Deciding a node decides what detection proposed about it; a
			// relationship someone already decided keeps their decision.
			if err := db.DecideDetectedEdges(sqlDB, n.ID, n.Status); err != nil {
				jsonError(w, err.Error(), 500)
				return
			}
			s.broadcastInfraRefresh(sqlDB, n.WorkspaceID)
		}
		s.broadcastPatch("infra:upserted", *n)
		jsonOK(w, n)

	case r.Method == http.MethodDelete && sub == "":
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.DeleteInfraNode(sqlDB, id); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("infra:deleted", map[string]string{"id": id, "workspaceId": workspaceID})
		jsonOK(w, map[string]string{"deleted": id})

	case r.Method == http.MethodPost && sub == "contents":
		s.handleInfraContents(w, r, id)

	case r.Method == http.MethodDelete && id == "contents" && sub != "":
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.DeleteInfraContent(sqlDB, sub); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("infra:contents", map[string]any{"workspaceId": workspaceID, "removed": []string{sub}})
		jsonOK(w, map[string]string{"deleted": sub})

	case r.Method == http.MethodPost && id == "requirements" && sub == "":
		s.handleInfraRequirements(w, r)

	case r.Method == http.MethodPost && sub == "position":
		var body struct {
			WorkspaceID string  `json:"workspaceId"`
			X           float64 `json:"x"`
			Y           float64 `json:"y"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpdateInfraPosition(sqlDB, id, body.X, body.Y); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"id": id, "x": body.X, "y": body.Y})

	default:
		http.NotFound(w, r)
	}
}

// handleInfraConnect creates a typed edge from a file or system to an infra
// node, validating the edge kind against the node's category.
func (s *Server) handleInfraConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string  `json:"workspaceId"`
		SrcID       string  `json:"srcId"`
		SrcType     string  `json:"srcType"` // 'file' | 'system'
		InfraID     string  `json:"infraId"`
		Kind        string  `json:"kind"` // 'READS'|'WRITES'|'PUBLISHES'|... per category
		Evidence    *string `json:"evidence"`
		CreatedBy   string  `json:"createdBy"` // 'user'|'agent'|'parser'|'runtime'; defaults to 'user'
		TargetItem  string  `json:"targetItem"` // the contents item: table, topic, key pattern, ...
		Status      string  `json:"status"`     // 'proposed' for detections; defaults to 'confirmed'
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	if body.SrcType != "file" && body.SrcType != "system" {
		jsonError(w, "srcType must be 'file' or 'system'", 400)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	n, err := db.GetInfraNode(sqlDB, body.InfraID)
	if err != nil || n == nil {
		jsonError(w, "infra node not found", 404)
		return
	}
	if !registry.ValidEdgeKind(n.Category, body.Kind) {
		jsonError(w, fmt.Sprintf("edge kind %q is not valid for category %q (valid: %s)",
			body.Kind, n.Category, strings.Join(registry.EdgeKindsFor(n.Category), ", ")), 400)
		return
	}
	if body.CreatedBy == "" {
		body.CreatedBy = "user"
	}
	dep := db.Dependency{
		WorkspaceID:    body.WorkspaceID,
		Src:            body.SrcID,
		Dst:            body.InfraID,
		SrcType:        body.SrcType,
		DstType:        "infra",
		DependencyType: body.Kind,
		CreatedBy:      body.CreatedBy,
		Evidence:       body.Evidence,
		TargetItem:     body.TargetItem,
		Status:         body.Status,
	}
	if dep.Status != "" && !validDecision(dep.Status) {
		jsonError(w, "status must be proposed|confirmed|dismissed", 400)
		return
	}
	if err := db.UpsertDependency(sqlDB, dep); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.broadcastPatch("infra:connected", dep)
	jsonOK(w, dep)
}

// handleInfraEdge handles DELETE /api/infra/edge/:id.
func (s *Server) handleInfraEdge(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/infra/edge/")
	if id != "" && r.Method == http.MethodPut {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			Status      string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !validDecision(body.Status) {
			jsonError(w, "send {workspaceId, status: proposed|confirmed|dismissed}", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.SetDependencyStatus(sqlDB, id, body.Status); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("infra:edge_status", map[string]string{"id": id, "status": body.Status, "workspaceId": body.WorkspaceID})
		jsonOK(w, map[string]string{"id": id, "status": body.Status})
		return
	}
	if id == "" || r.Method != http.MethodDelete {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if err := db.DeleteDependency(sqlDB, id); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.broadcastPatch("infra:disconnected", map[string]string{"id": id, "workspaceId": workspaceID})
	jsonOK(w, map[string]string{"deleted": id})
}

func validDecision(status string) bool {
	return status == "proposed" || status == "confirmed" || status == "dismissed"
}

var implementationKinds = map[string]bool{"in-process": true, "local-service": true, "emulator": true, "vendor": true}

// validateImplementations checks the shape of a node's implementations list.
func validateImplementations(raw json.RawMessage) error {
	var list []struct {
		Environment string `json:"environment"`
		Kind        string `json:"kind"`
		Ref         string `json:"ref"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return fmt.Errorf("implementations must be a list of {environment, kind, ref, evidence}")
	}
	for _, impl := range list {
		if !implementationKinds[impl.Kind] {
			return fmt.Errorf("implementation kind %q must be in-process, local-service, emulator or vendor", impl.Kind)
		}
		if impl.Environment == "" || impl.Ref == "" {
			return fmt.Errorf("every implementation needs an environment and a ref")
		}
	}
	return nil
}

// handleInfraContents records contract items on one node.
func (s *Server) handleInfraContents(w http.ResponseWriter, r *http.Request, infraID string) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Source      string `json:"source"`
		Items       []struct {
			Kind     string          `json:"kind"`
			Name     string          `json:"name"`
			Detail   json.RawMessage `json:"detail"`
			Evidence *string         `json:"evidence"`
		} `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Items) == 0 {
		jsonError(w, "send {workspaceId, items:[{kind, name, detail?, evidence?}]}", 400)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if n, err := db.GetInfraNode(sqlDB, infraID); err != nil || n == nil {
		jsonError(w, "infra node not found", 404)
		return
	}
	saved := make([]db.InfraContent, 0, len(body.Items))
	for _, item := range body.Items {
		if !db.ContentKinds[item.Kind] || strings.TrimSpace(item.Name) == "" {
			jsonError(w, fmt.Sprintf("item %q: kind must be one of table, collection, topic, key_pattern, bucket, index, method, webhook, model, prompt, flag, schedule, channel, route, event, and name is required", item.Name), 400)
			return
		}
		c := db.InfraContent{WorkspaceID: body.WorkspaceID, InfraID: infraID, Kind: item.Kind,
			Name: strings.TrimSpace(item.Name), Detail: item.Detail, Evidence: item.Evidence, Source: body.Source}
		if err := db.UpsertInfraContent(sqlDB, &c); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		saved = append(saved, c)
	}
	s.broadcastPatch("infra:contents", map[string]any{"workspaceId": body.WorkspaceID, "items": saved})
	jsonOK(w, map[string]any{"items": saved})
}

// handleInfraRequirements records what running the code needs.
func (s *Server) handleInfraRequirements(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string                `json:"workspaceId"`
		Items       []db.InfraRequirement `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Items) == 0 {
		jsonError(w, "send {workspaceId, items:[{kind, name, infraId?, evidence?, present?}]}", 400)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	for i := range body.Items {
		item := &body.Items[i]
		item.WorkspaceID = body.WorkspaceID
		if item.Kind != "" && item.Kind != "env" {
			jsonError(w, "requirement kind must be env", 400)
			return
		}
		if strings.TrimSpace(item.Name) == "" {
			jsonError(w, "every requirement needs a name", 400)
			return
		}
		if item.Source == "" {
			item.Source = "agent"
		}
		if err := db.UpsertInfraRequirement(sqlDB, item); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
	}
	s.broadcastPatch("infra:requirements", map[string]any{"workspaceId": body.WorkspaceID, "items": body.Items})
	jsonOK(w, map[string]any{"items": body.Items})
}

// detectInfra proposes the root's infrastructure from the index (L2) and tells
// open canvases. Runs are serialized per workspace; a failure is logged and
// the previous map stands.
func (s *Server) detectInfra(sqlDB *sql.DB, root db.Root) {
	s.detectMu.Lock()
	lock := s.detecting[root.WorkspaceID]
	if lock == nil {
		lock = &sync.Mutex{}
		s.detecting[root.WorkspaceID] = lock
	}
	s.detectMu.Unlock()
	lock.Lock()
	defer lock.Unlock()

	started := time.Now()
	in, err := infradetect.Load(sqlDB, root, s.currentRegistry())
	if err != nil {
		log.Printf("[infra] detection inputs for %s: %v", root.Path, err)
		return
	}
	result := infradetect.Analyze(in)
	changes, err := infradetect.Apply(sqlDB, root.WorkspaceID, root.ID, result)
	if err != nil {
		log.Printf("[infra] detection for %s: %v", root.Path, err)
		return
	}
	s.detectMu.Lock()
	s.infraUnresolved[root.WorkspaceID] = result.Unresolved
	s.detectMu.Unlock()
	log.Printf("[infra] detection for %s: %d proposals, %d relationships, %d withdrawn in %s",
		root.Path, len(result.Proposals), len(changes.Connected), len(changes.Disconnected)+len(changes.Removed), time.Since(started).Round(time.Millisecond))
	s.broadcastInfraRefresh(sqlDB, root.WorkspaceID)
}

// broadcastInfraRefresh sends the whole infra layer in one patch: detection
// touches dozens of rows at once, and one message keeps canvases consistent.
func (s *Server) broadcastInfraRefresh(sqlDB *sql.DB, workspaceID string) {
	nodes, err := db.GetInfraNodes(sqlDB, workspaceID)
	if err != nil {
		return
	}
	edges, err := db.GetInfraEdges(sqlDB, workspaceID)
	if err != nil {
		return
	}
	s.broadcastPatch("infra:refreshed", map[string]any{"workspaceId": workspaceID, "nodes": nodes, "edges": edges})
}

// handleInfraDetect runs detection on demand: POST {workspaceId}.
func (s *Server) handleInfraDetect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "send {workspaceId}", 400)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	roots, err := db.GetRoots(sqlDB, body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	for _, root := range roots {
		if err := indexer.EnsureDetectionEvidence(sqlDB, root); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.detectInfra(sqlDB, root)
	}
	s.writeInfraList(w, sqlDB, body.WorkspaceID)
}

func (s *Server) writeInfraList(w http.ResponseWriter, sqlDB *sql.DB, workspaceID string) {
	nodes, err := db.GetInfraNodes(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	edges, err := db.GetInfraEdges(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	contents, err := db.GetInfraContents(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	requirements, err := db.GetInfraRequirements(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.detectMu.Lock()
	unresolved := s.infraUnresolved[workspaceID]
	s.detectMu.Unlock()
	if unresolved == nil {
		unresolved = []infradetect.Unresolved{}
	}
	// The relationships each role on the map can record, so an agent names the
	// right kind the first time.
	edgeKinds := map[string][]string{}
	for _, n := range nodes {
		edgeKinds[n.Category] = registry.EdgeKindsFor(n.Category)
	}
	jsonOK(w, map[string]any{"nodes": nodes, "edges": edges, "contents": contents,
		"requirements": requirements, "unresolved": unresolved, "edgeKinds": edgeKinds})
}
