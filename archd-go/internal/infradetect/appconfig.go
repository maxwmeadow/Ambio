package infradetect

import (
	"regexp"
	"strings"
)

var (
	railsAdapter = regexp.MustCompile(`(?m)^\s*adapter:\s*["']?(\w+)`)
	jdbcURL      = regexp.MustCompile(`jdbc:([a-z0-9]+):`)
	anyURL       = regexp.MustCompile(`[a-z][a-z0-9+.-]*://[^\s"'<>]+`)
)

// Framework adapters and JDBC drivers, by the name the config uses.
var adapterService = map[string]string{
	"postgresql": "postgresql/postgres", "postgis": "postgresql/postgres", "mysql2": "mysql/mysql",
	"mysql": "mysql/mysql", "trilogy": "mysql/mysql", "sqlite3": "sqlite/sqlite", "sqlite": "sqlite/sqlite",
	"sqlserver": "", "mariadb": "mysql/mysql",
}

// readAppConfig reads the framework config files that name a database or
// broker instead of any import doing so: Rails database.yml, Spring
// application.properties / .yml, .NET appsettings.json. Adapters and JDBC
// drivers name the service; URLs are matched against the registry's patterns.
// Values are read only to recognise the service; nothing is stored but the
// file reference.
func (d *detection) readAppConfig() {
	files := d.configFiles("database.yml", "application.properties", "application.yml", "application.yaml",
		"appsettings.json", "appsettings.Development.json")
	for _, file := range files {
		body := d.in.Config[file]
		propose := func(serviceID, detail string) {
			if serviceID == "" {
				return
			}
			s, ok := d.in.Registry.Get(serviceID)
			if !ok {
				return
			}
			p := d.proposal(s)
			p.Evidence = append(p.Evidence, Evidence{Signal: "config", Ref: file, Detail: detail})
		}
		for _, m := range railsAdapter.FindAllSubmatch(body, -1) {
			propose(adapterService[strings.ToLower(string(m[1]))], "adapter "+string(m[1]))
		}
		for _, m := range jdbcURL.FindAllSubmatch(body, -1) {
			propose(adapterService[strings.ToLower(string(m[1]))], "jdbc "+string(m[1]))
		}
		for _, url := range anyURL.FindAll(body, -1) {
			for _, s := range d.in.Registry.All() {
				if s.Detect == nil {
					continue
				}
				for _, pattern := range s.Detect.URLPatterns {
					re, ok := urlPatternMu[pattern]
					if !ok {
						re, _ = regexp.Compile(pattern)
						urlPatternMu[pattern] = re
					}
					if re != nil && re.Match(url) {
						propose(s.ID, "connection URL")
					}
				}
			}
		}
	}
}
