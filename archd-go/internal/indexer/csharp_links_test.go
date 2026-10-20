package indexer

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"ambio.local/archd/internal/db"
)

func TestCSharpFilesLinkToTheTypesTheyUse(t *testing.T) {
	dir := t.TempDir()
	sources := map[string]string{
		// Same namespace: no using needed.
		"Services/OrderService.cs": `namespace Shop.Services;
public class OrderService {
    private readonly PriceCalculator _prices = new PriceCalculator();
    public Order Place(Cart cart) => new Order(_prices.Total(cart));
}`,
		"Services/PriceCalculator.cs": `namespace Shop.Services {
    public class PriceCalculator { public decimal Total(Shop.Models.Cart c) => 0; }
}`,
		// Reached through a using, and through the enclosing namespace Shop.
		"Models/Order.cs": `namespace Shop.Models;
public record Order(decimal Total);`,
		"Models/Cart.cs": `namespace Shop.Models;
public class Cart { }`,
		"Models/Unused.cs": `namespace Shop.Models;
public class Coupon { }`,
		"Shared.cs": `namespace Shop;
public enum Currency { Usd }`,
		"Usings.cs": `global using Shop.Models;`,
		// Unity-style scripts in the global namespace.
		"Player.cs":    `public class Player { Inventory bag = new Inventory(); } // Coupon in a comment`,
		"Inventory.cs": `public class Inventory { string note = "Order"; }`,
	}
	var files []db.File
	for rel, src := range sources {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, db.File{ID: rel, Path: path, RelPath: rel, Language: "csharp"})
	}
	idx := buildCSharpIndex(files)

	for from, want := range map[string][]string{
		// PriceCalculator by its own namespace; Order and Cart by the global using.
		"Services/OrderService.cs":    {"Models/Cart.cs", "Models/Order.cs", "Services/PriceCalculator.cs"},
		"Services/PriceCalculator.cs": {"Models/Cart.cs"},
		"Models/Order.cs":             nil,
		// Comments and strings mention types without using them.
		"Player.cs":    {"Inventory.cs"},
		"Inventory.cs": nil,
	} {
		if got := idx.links(from); !reflect.DeepEqual(got, want) {
			t.Errorf("%s links %v, want %v", from, got, want)
		}
	}
}
