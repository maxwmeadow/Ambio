package indexer

import (
	"database/sql"
	"sync"
	"time"

	"ambio.local/archd/internal/db"
)

// Calls are resolved by name, so a name defined once in the project used to
// link any call to it: TypeScript "calling" a Java method of the same name,
// one repository calling into another it never imports. And when a branch
// switch removed a name from one repository, the same name elsewhere became
// unique and calls all over the project suddenly resolved to it. A call now
// reaches only code its language can call, and in a folder holding several
// repositories only its own repository, unless it imports the file
// (DECISIONS 2026-10-21: repositories link only where an import resolves).

type callScope struct {
	family     map[string]string // file ID → language family
	repository map[string]string // file ID → repository folder, "" for none
}

func (scope callScope) reachable(caller, callee string, imported map[string]bool) bool {
	if scope.family[caller] != scope.family[callee] {
		return false
	}
	return scope.repository[caller] == scope.repository[callee] || imported[callee]
}

func callScopes(sqlDB *sql.DB, root db.Root) (callScope, error) {
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return callScope{}, err
	}
	repositories := cachedRepositories(root)
	scope := callScope{family: make(map[string]string, len(files)), repository: make(map[string]string, len(files))}
	for _, file := range files {
		scope.family[file.ID] = languageFamily(file.Language)
		scope.repository[file.ID] = repositoryOf(file.RelPath, repositories)
	}
	return scope, nil
}

// languageFamily groups languages whose code calls one another directly.
func languageFamily(language string) string {
	switch language {
	case "typescript", "tsx", "javascript", "jsx":
		return "js"
	case "c", "cpp":
		return "c"
	case "java", "kotlin", "scala", "groovy":
		return "jvm"
	}
	return language
}

var (
	repositoriesMu    sync.Mutex
	repositoriesCache = map[string]cachedRepositoryList{}
)

type cachedRepositoryList struct {
	list []string
	at   time.Time
}

// cachedRepositories is Repositories, read at most every ten seconds: the
// call graph is rebuilt on edits, and finding repositories walks folders.
func cachedRepositories(root db.Root) []string {
	repositoriesMu.Lock()
	defer repositoriesMu.Unlock()
	cached, ok := repositoriesCache[root.ID+"\x00"+root.Path]
	if ok && time.Since(cached.at) < 10*time.Second {
		return cached.list
	}
	list := Repositories(root)
	repositoriesCache[root.ID+"\x00"+root.Path] = cachedRepositoryList{list: list, at: time.Now()}
	return list
}
