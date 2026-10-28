package indexer

import (
	"database/sql"
	"path/filepath"
	"sort"
	"strings"

	"ambio.local/archd/internal/cluster"
	"ambio.local/archd/internal/db"
)

// Several repositories in one project (docs/GIT_AND_PROJECT_SHAPES.md
// "Shapes", WORK git-repo-frames). Each repository inside a project gets a
// top-level frame - a system of kind "repository" - and the classifier groups
// a repository's files only with each other, under its frame. Louvain merges
// along edges, so clustering each repository on its own is what keeps an
// inferred system from spanning two of them. A person or an agent may still
// group across repositories; those systems are authored and left alone.

// RepositorySystemKind marks the frame holding one repository.
const RepositorySystemKind = "repository"

// repositoryOf is the repository folder (from repositories) holding relPath,
// the deepest one when they nest, or "" when no repository holds it.
func repositoryOf(relPath string, repositories []string) string {
	best := ""
	for _, folder := range repositories {
		if strings.HasPrefix(relPath, folder+"/") && len(folder) > len(best) {
			best = folder
		}
	}
	return best
}

// repositoryFrameID is stable per workspace and folder, so a frame keeps its
// layout and anything a person adopted about it across reclustering.
func repositoryFrameID(workspaceID, folder string) string {
	return stableClusterSystemID(workspaceID, nil, "repository:"+folder)
}

// clusterRepositories plans the systems for a root's managed files: per
// repository under that repository's frame, and the rest at the top level as
// before. With no repository inside the root it is exactly clusterLevel.
func clusterRepositories(
	plan *clusterPlan,
	root db.Root,
	input cluster.ClusterInput,
	repositories []string,
	existing []db.System,
) (int, error) {
	if len(repositories) == 0 {
		return clusterLevel(plan, root, input, nil, map[string]struct{}{}, 0)
	}
	groups := map[string][]db.File{}
	for _, file := range input.Files {
		folder := repositoryOf(filepath.ToSlash(file.RelPath), repositories)
		groups[folder] = append(groups[folder], file)
	}

	total := 0
	if outside := groups[""]; len(outside) > 0 {
		sub := input
		sub.Files = outside
		assigned, err := clusterLevel(plan, root, sub, nil, map[string]struct{}{}, 0)
		if err != nil {
			return total, err
		}
		total += assigned
	}

	// Names are unique among siblings: a frame yields to a top-level system
	// that already has its folder's name.
	taken := map[string]struct{}{}
	for _, system := range existing {
		if _, protected := plan.protectedSystemIDs[system.ID]; protected && system.ParentID == nil {
			taken[strings.ToLower(system.Name)] = struct{}{}
		}
	}
	for _, system := range plan.systems {
		if system.ParentID == nil {
			taken[strings.ToLower(system.Name)] = struct{}{}
		}
	}

	folders := append([]string(nil), repositories...)
	sort.Strings(folders)
	for _, folder := range folders {
		members := groups[folder]
		if len(members) == 0 {
			continue
		}
		frameID := repositoryFrameID(root.WorkspaceID, folder)
		name := folder
		if _, clash := taken[strings.ToLower(name)]; clash {
			name = folder + " (repository)"
		}
		if _, protected := plan.protectedSystemIDs[frameID]; !protected {
			description := "The " + folder + " repository"
			plan.systems[frameID] = db.System{
				ID:          frameID,
				WorkspaceID: root.WorkspaceID,
				Name:        name,
				Source:      "cluster",
				Kind:        RepositorySystemKind,
				Description: &description,
			}
		}
		taken[strings.ToLower(name)] = struct{}{}
		sub := input
		sub.Files = members
		sub.Cochange = cluster.BuildCochange(filepath.Join(root.Path, filepath.FromSlash(folder)), rerooted(members, folder))
		assigned, err := clusterLevel(plan, root, sub, &frameID, map[string]struct{}{name: {}}, 1)
		if err != nil {
			return total, err
		}
		total += assigned
	}
	return total, nil
}

// rerooted copies files with paths relative to a repository folder, which is
// how that repository's own history names them.
func rerooted(files []db.File, folder string) []db.File {
	copies := make([]db.File, len(files))
	for index, file := range files {
		file.RelPath = strings.TrimPrefix(filepath.ToSlash(file.RelPath), folder+"/")
		copies[index] = file
	}
	return copies
}

// NeedsRepositoryFrames reports a root holding repositories whose map has no
// repository frame yet - one indexed before frames existed - so its next
// sync reclusters once.
func NeedsRepositoryFrames(sqlDB *sql.DB, root db.Root) bool {
	if len(Repositories(root)) == 0 {
		return false
	}
	systems, err := db.GetSystems(sqlDB, root.WorkspaceID)
	if err != nil {
		return false
	}
	for _, system := range systems {
		if system.Kind == RepositorySystemKind {
			return false
		}
	}
	return true
}
