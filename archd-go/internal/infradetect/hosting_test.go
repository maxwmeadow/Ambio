package infradetect

import "testing"

func hostsOf(p *Proposal) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, c := range p.Contents {
		if c.Kind == "hosts" {
			out[c.Name] = c.Detail
		}
	}
	return out
}

func TestEachDockerfileIsAContainerAndPlatformsNestThem(t *testing.T) {
	result := Analyze(inputs(nil, nil, nil, map[string]string{
		"api/Dockerfile":     "FROM node:20\n",
		"worker/Dockerfile":  "FROM python:3.12\n",
		"api/package.json":   `{"dependencies":{"stripe":"^17"}}`,
		"fly.toml":           "app = \"x\"\n[build]\n  dockerfile = \"api/Dockerfile\"\n",
		"worker/render.yaml": "services:\n  - type: worker\n    rootDir: worker\n",
	}))
	var containers []Proposal
	for _, p := range result.Proposals {
		if p.Service == "docker/docker" {
			containers = append(containers, p)
		}
	}
	if len(containers) != 2 {
		t.Fatalf("one container per Dockerfile: %+v", containers)
	}
	for _, c := range containers {
		if c.Name != "Docker · "+c.Instance || len(hostsOf(&c)) != 1 {
			t.Errorf("a container is named for its folder and hosts it: %+v", c)
		}
	}
	fly := find(result, "fly/platform")
	if fly == nil {
		t.Fatal("fly.toml proposes Fly")
	}
	api := hostsOf(fly)["api"]
	if api == nil || api["via"] != "docker/docker#api" {
		t.Errorf("Fly runs the api folder through its Docker image: %+v", hostsOf(fly))
	}
	render := find(result, "render/platform")
	if render == nil || hostsOf(render)["worker"] == nil {
		t.Errorf("render.yaml's rootDir is what Render runs: %+v", render)
	}
	if stripe := find(result, "stripe/api"); stripe == nil || !stripe.DeclaredOnly || stripe.Evidence[0].Ref != "api/package.json" {
		t.Errorf("a manifest in a service folder is read: %+v", stripe)
	}
}
