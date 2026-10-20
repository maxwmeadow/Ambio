package parser

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The declarations each of these languages has, by the names the source
// gives them: what the map shows and what a run's watch resolves against.
func TestSymbolsInScalaGroovyLuaShellAndElixir(t *testing.T) {
	cases := []struct {
		file, src string
		want      []string // "kind name"
	}{
		{"Pricing.scala", "package shop\ntrait Shape { def area: Double }\ncase class Circle(r: Double) extends Shape { def area: Double = 3.14 * r * r }\nobject Pricing { def total(n: Int): Int = n }\nclass Stock(n: Int) { def reserve(q: Int): Int = n - q }\nenum Level { case Low, High }\n",
			[]string{"interface Shape", "function area", "class Circle", "function area", "class Pricing", "function total", "class Stock", "function reserve", "type Level"}},
		{"Stock.groovy", "package shop\nclass Stock {\n  int reserve(Map stock, String item) { return 1 }\n  def price(order) { 2 }\n}\ndef topLevel(x) { x + 1 }\n",
			[]string{"class Stock", "function reserve", "function price", "function topLevel"}},
		{"cart.lua", "local M = {}\nfunction M.reserve(stock, item) return 1 end\nlocal function helper(x) return x end\nfunction M:add(a) end\nfunction plain() end\nreturn M\n",
			[]string{"variable M", "function reserve", "function helper", "function add", "function plain"}},
		{"deploy.sh", "#!/bin/bash\nreserve() { echo 1; }\nfunction price { echo 2; }\n",
			[]string{"function reserve", "function price"}},
		{"checkout.ex", "defmodule Shop.Checkout do\n  def total(%Cart{} = c), do: 1\n  defp helper(x) when x > 0 do\n    x\n  end\n  defmacro twice(x), do: x\nend\n",
			[]string{"class Shop.Checkout", "function total", "function helper", "function twice"}},
	}
	for _, c := range cases {
		path := filepath.Join(t.TempDir(), c.file)
		if err := os.WriteFile(path, []byte(c.src), 0o644); err != nil {
			t.Fatal(err)
		}
		result, err := ParseFile(path, c.file)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, s := range result.Symbols {
			got = append(got, s.Kind+" "+s.Name)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s (%s)\n got  %v\n want %v", c.file, result.Language, got, c.want)
		}
	}
}
