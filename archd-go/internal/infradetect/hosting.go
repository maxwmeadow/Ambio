package infradetect

import (
	"bufio"
	"bytes"
	"encoding/json"
	"path"
	"regexp"
	"strings"
)

// readHosting finds what runs the code and which part of the project each
// host runs (INFRA_LAYER_PLAN.md, "Canvas placement"): the canvas draws hosts
// as frames around the systems they hold, nested the way they really are - a
// backend in a Docker image, on Fly.
//
// Every Dockerfile is its own container, named for its folder. A platform
// records the folders it runs as "hosts" contents; when it builds from a
// Dockerfile, the entry names that container ("via"), so the canvas nests the
// container inside the platform instead of placing both around the same code.
func (d *detection) readHosting() {
	containers := map[string]string{} // Dockerfile path → container key
	for file := range d.in.Config {
		name := path.Base(file)
		if name != "Dockerfile" && !strings.HasPrefix(name, "Dockerfile.") {
			continue
		}
		s, ok := d.in.Registry.Get("docker/docker")
		if !ok {
			continue
		}
		dir := path.Dir(file)
		instance := folderLabel(dir)
		if variant := strings.TrimPrefix(name, "Dockerfile."); variant != name {
			instance += "." + variant
		}
		p := d.instance(s, instance)
		p.Evidence = append(p.Evidence, Evidence{Signal: "config", Ref: file})
		p.Contents = append(p.Contents, Content{Kind: "hosts", Name: folderLabel(dir),
			Detail: map[string]any{"dir": dir, "config": file}, Evidence: file})
		containers[file] = proposalKey(p)
	}
	// The container a platform builds from: its named Dockerfile, else one
	// sitting in the folder it deploys.
	containerFor := func(dockerfile, dir string) string {
		if dockerfile != "" {
			if key, ok := containers[path.Clean(dockerfile)]; ok {
				return key
			}
		}
		return containers[path.Join(dir, "Dockerfile")]
	}
	host := func(service, file, dir, dockerfile string) {
		s, ok := d.in.Registry.Get(service)
		if !ok {
			return
		}
		p := d.proposal(s)
		p.Evidence = append(p.Evidence, Evidence{Signal: "config", Ref: file})
		detail := map[string]any{"dir": dir, "config": file}
		if via := containerFor(dockerfile, dir); via != "" {
			detail["via"] = via
		}
		p.Contents = append(p.Contents, Content{Kind: "hosts", Name: folderLabel(dir), Detail: detail, Evidence: file})
	}

	for _, file := range d.configFiles("fly.toml") {
		base := path.Dir(file)
		dockerfile := tomlValue(d.in.Config[file], "dockerfile")
		if dockerfile != "" {
			// fly.toml paths are relative to the file; a Dockerfile elsewhere
			// means that folder is what runs.
			dockerfile = path.Join(base, dockerfile)
			host("fly/platform", file, path.Dir(dockerfile), dockerfile)
		} else {
			host("fly/platform", file, base, "")
		}
	}
	for _, file := range d.configFiles("railway.json") {
		var config struct {
			Build struct {
				DockerfilePath string `json:"dockerfilePath"`
			} `json:"build"`
		}
		_ = json.Unmarshal(d.in.Config[file], &config)
		base := path.Dir(file)
		if config.Build.DockerfilePath != "" {
			dockerfile := path.Join(base, config.Build.DockerfilePath)
			host("railway/platform", file, path.Dir(dockerfile), dockerfile)
		} else {
			host("railway/platform", file, base, "")
		}
	}
	for _, file := range d.configFiles("railway.toml") {
		base := path.Dir(file)
		if dockerfile := tomlValue(d.in.Config[file], "dockerfilePath"); dockerfile != "" {
			dockerfile = path.Join(base, dockerfile)
			host("railway/platform", file, path.Dir(dockerfile), dockerfile)
		} else {
			host("railway/platform", file, base, "")
		}
	}
	for _, file := range d.configFiles("render.yaml") {
		dirs := yamlValues(d.in.Config[file], "rootDir")
		dockerfiles := yamlValues(d.in.Config[file], "dockerfilePath")
		if len(dirs) == 0 && len(dockerfiles) == 0 {
			host("render/platform", file, path.Dir(file), "")
		}
		for _, dir := range dirs {
			host("render/platform", file, path.Clean(dir), "")
		}
		for _, dockerfile := range dockerfiles {
			dockerfile = path.Clean(strings.TrimPrefix(dockerfile, "./"))
			host("render/platform", file, path.Dir(dockerfile), dockerfile)
		}
	}
	for _, file := range d.configFiles("netlify.toml") {
		base := path.Dir(file)
		if dir := tomlValue(d.in.Config[file], "base"); dir != "" {
			base = path.Join(base, dir)
		}
		host("netlify/platform", file, base, "")
	}
	// Vercel says which files it runs (RUNS_ON, from vercel.json functions);
	// the folder holding vercel.json is what it deploys.
	for _, file := range d.configFiles("vercel.json") {
		host("vercel/platform", file, path.Dir(file), "")
	}
}

// folderLabel names a folder for people: "api", or "app" for the root.
func folderLabel(dir string) string {
	if dir == "." || dir == "" {
		return "app"
	}
	return dir
}

var tomlLine = regexp.MustCompile(`^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"`)

// tomlValue is the first string value for a key, in any table. Enough for the
// handful of keys hosting needs; not a TOML parser.
func tomlValue(body []byte, key string) string {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		if m := tomlLine.FindStringSubmatch(scanner.Text()); m != nil && m[1] == key {
			return m[2]
		}
	}
	return ""
}

// yamlValues lists every scalar value of a key, at any depth.
func yamlValues(body []byte, key string) []string {
	var out []string
	pattern := regexp.MustCompile(`^\s*-?\s*` + regexp.QuoteMeta(key) + `:\s*["']?([^"'#\s]+)`)
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		if m := pattern.FindStringSubmatch(scanner.Text()); m != nil {
			out = append(out, m[1])
		}
	}
	return out
}
