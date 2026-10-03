package delta

import (
	"encoding/json"
	"testing"

	"ambio.local/archd/internal/db"
)

func infraEvent(kind, fileID, path, infraID, infraName, relationship, item, actor string, ts int64) db.StructuralEvent {
	detail, _ := json.Marshal(InfraDetail{Relationship: relationship, Item: item, SrcSystem: "orders", SrcSystemName: "Orders"})
	return db.StructuralEvent{
		Kind: kind, Actor: actor, TS: ts, SubjectID: fileID, SubjectLabel: path,
		ObjectID: infraID, ObjectLabel: infraName, Detail: string(detail),
	}
}

func TestCodeThatStartsWritingToInfrastructureIsAClaim(t *testing.T) {
	summary := Aggregate([]db.StructuralEvent{
		infraEvent(db.EventInfraLinked, "f1", "src/orders/save.ts", "redis", "Redis", "WRITES", "orders:*", "agent", 1),
		infraEvent(db.EventInfraLinked, "f2", "src/orders/cache.ts", "redis", "Redis", "WRITES", "carts:*", "agent", 2),
		// Linked and unlinked in the same window is no change at all.
		infraEvent(db.EventInfraLinked, "f1", "src/orders/save.ts", "kafka", "Kafka", "PUBLISHES", "", "agent", 3),
		infraEvent(db.EventInfraUnlinked, "f1", "src/orders/save.ts", "kafka", "Kafka", "PUBLISHES", "", "agent", 4),
		infraEvent(db.EventInfraUnlinked, "f3", "src/orders/legacy.ts", "pg", "Postgres", "READS", "", "human", 5),
	}, 0, 10)
	if summary.Empty || len(summary.Infra) != 3 {
		t.Fatalf("infra = %+v", summary.Infra)
	}
	claims := BuildClaims(summary, nil)
	byTitle := map[string]Claim{}
	for _, claim := range claims {
		byTitle[claim.Title] = claim
	}
	writes, ok := byTitle["Orders now writes to Redis"]
	if !ok {
		t.Fatalf("claims = %+v", claims)
	}
	if writes.Kind != ClaimInfraLinked || writes.Actor != "agent" || len(writes.Evidence) != 2 || writes.Subtitle != "carts:*, orders:*" {
		t.Fatalf("writes = %+v", writes)
	}
	if reads, ok := byTitle["Orders no longer reads from Postgres"]; !ok || reads.Kind != ClaimInfraUnlinked || reads.Actor != "human" {
		t.Fatalf("claims = %+v", claims)
	}
	for title := range byTitle {
		if title == "Orders now publishes to Kafka" || title == "Orders no longer publishes to Kafka" {
			t.Fatalf("a link undone in the same window was claimed: %s", title)
		}
	}
}
