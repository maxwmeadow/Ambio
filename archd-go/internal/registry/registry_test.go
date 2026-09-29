package registry

import "testing"

func TestServicesInheritCategoryCapabilities(t *testing.T) {
	r := &Registry{services: make(map[string]Service)}
	r.addFile([]byte(`[
		{"id":"test/host","name":"Host","category":"platform","provider":"test","brand":{"icon":"","color":"#fff"}},
		{"id":"test/db","name":"Database","category":"database","provider":"test","brand":{"icon":"","color":"#fff"}}
	]`), "test", "test.json")

	host, ok := r.Get("test/host")
	if !ok || !containsCapability(host.Capabilities, "container") || !containsCapability(host.Capabilities, "environment") {
		t.Fatalf("platform capabilities = %v", host.Capabilities)
	}
	database, ok := r.Get("test/db")
	if !ok || !containsCapability(database.Capabilities, "schema") {
		t.Fatalf("database capabilities = %v", database.Capabilities)
	}
}

func containsCapability(capabilities []string, wanted string) bool {
	for _, capability := range capabilities {
		if capability == wanted {
			return true
		}
	}
	return false
}

func TestEveryRoleAcceptsImplementsAndUses(t *testing.T) {
	for category := range Categories {
		for _, kind := range []string{"IMPLEMENTS", "USES"} {
			if !ValidEdgeKind(category, kind) {
				t.Errorf("%s should accept %s", category, kind)
			}
		}
	}
	if ValidEdgeKind("queue", "READS") {
		t.Error("a queue has publishers and consumers, not readers")
	}
	if ValidEdgeKind("nonsense", "USES") {
		t.Error("an unknown role accepts nothing")
	}
}

func TestCDNIsAPlatformSubtype(t *testing.T) {
	r := Load(nil)
	for _, id := range []string{"aws/cloudfront", "cloudflare/cdn", "fastly/cdn", "generic/cdn"} {
		s, ok := r.Get(id)
		if !ok || s.Category != "platform" || s.Subtype != "cdn" {
			t.Errorf("%s: %+v", id, s)
		}
	}
	r2 := &Registry{services: map[string]Service{}}
	r2.addFile([]byte(`{"id":"acme/edge","name":"Acme Edge","category":"cdn","provider":"acme"}`), "workspace", "old.json")
	if s, ok := r2.Get("acme/edge"); !ok || s.Category != "platform" || s.Subtype != "cdn" {
		t.Errorf("an older definition using cdn still loads as a platform: %+v", s)
	}
}

func TestNewRolesHaveServices(t *testing.T) {
	r := Load(nil)
	for id, category := range map[string]string{
		"generic/scheduler": "scheduler", "node-cron/cron": "scheduler", "vercel/cron": "scheduler",
		"generic/flags": "flags", "launchdarkly/flags": "flags",
		"generic/realtime": "realtime", "pusher/realtime": "realtime", "bullmq/bullmq": "queue",
	} {
		if s, ok := r.Get(id); !ok || s.Category != category {
			t.Errorf("%s should be a %s service: %+v", id, category, s)
		}
	}
}
