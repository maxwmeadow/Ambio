package parser

import (
	"reflect"
	"testing"
)

func TestImportSpecsForJavaRustRubyCpp(t *testing.T) {
	for _, tc := range []struct {
		lang, relPath, src string
		want               []string
	}{
		{"java", "src/main/java/shop/orders/Cart.java", `
package shop.orders;
import java.util.List;
import shop.payments.Stripe;
import static shop.util.Money.round;
import shop.billing.*;
/* import shop.ghost.Nope; */
`, []string{"java:class:java/util/List", "java:class:shop/payments/Stripe", "java:class:shop/util/Money", "java:pkg:shop/billing"}},
		{"rust", "src/orders/cart.rs", `
mod line;
pub mod totals;
use crate::payments::{stripe::Client, refunds as r};
use super::billing::Invoice;
use self::line::Line;
use std::collections::HashMap;
use serde::Serialize;
`, []string{
			"rust:path:src/orders/cart/line", "rust:path:src/orders/cart/totals",
			"rust:path:src/payments/stripe/Client", "rust:path:src/payments/refunds",
			"rust:path:src/orders/billing/Invoice", "rust:path:src/orders/cart/line/Line",
		}},
		{"ruby", "app/models/order.rb", `
require 'json'
require "shop/payments"
require_relative '../services/billing'
require_relative "line_item.rb"
`, []string{"ruby:req:json", "ruby:req:shop/payments", "ruby:path:app/services/billing", "ruby:path:app/models/line_item"}},
		{"cpp", "src/orders/cart.cpp", `
#include <vector>
#include "payments/stripe.h"
#  include "line.hpp"
`, []string{"cpp:inc:src/orders|payments/stripe.h", "cpp:inc:src/orders|line.hpp"}},
	} {
		got := extractTextImports([]byte(tc.src), tc.lang, tc.relPath)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s:\n got %q\nwant %q", tc.lang, got, tc.want)
		}
	}
}

func TestStylesheetImportSpecs(t *testing.T) {
	for _, tc := range []struct {
		lang, relPath, src string
		want               []string
	}{
		{"css", "web/src/app.css", `
@import "./tokens.css";
@import url("reset.css") screen;
@import url(print.css);
@import url(https://fonts.example/inter.css);
@import "//cdn.example/x.css";
/* @import "ghost.css"; */
@reference "../theme.css";
@config "./tailwind.config.js";
.card { composes: base from "./base.module.css"; }
@value ink from './colors.css';
`, []string{
			"css:path:web/src|./tokens.css", "css:path:web/src|reset.css", "css:path:web/src|print.css",
			"css:path:web/src|../theme.css", "css:path:web/src|./tailwind.config.js",
			"css:path:web/src|./base.module.css", "css:path:web/src|./colors.css",
		}},
		{"scss", "web/src/styles/app.scss", `
@use "sass:math";
@use "./variables" as v with ($font: "Inter");
@forward "mixins";
@import 'a', 'b';
// @import 'ghost';
@import "~bootstrap/scss/bootstrap";
@import "#{$theme}/colors";
`, []string{
			"css:path:web/src/styles|./variables", "css:path:web/src/styles|mixins",
			"css:path:web/src/styles|a", "css:path:web/src/styles|b",
		}},
	} {
		result := &Result{}
		parseStylesheet([]byte(tc.src), tc.lang, tc.relPath, result)
		if !reflect.DeepEqual(result.Imports, tc.want) {
			t.Errorf("%s:\n got %q\nwant %q", tc.lang, result.Imports, tc.want)
		}
	}
}

func TestStylesheetLanguagesAndSymbols(t *testing.T) {
	for file, want := range map[string]string{"a.css": "css", "a.SCSS": "scss", "a.sass": "sass", "a.less": "less"} {
		if got := detectLanguage(file); got != want {
			t.Errorf("detectLanguage(%q) = %q, want %q", file, got, want)
		}
	}
	result := &Result{}
	parseStylesheet([]byte("@mixin card($pad) {\n  padding: $pad;\n  .x { color: red; }\n}\n\n@function double($n) { @return $n * 2; }\n.rule { color: blue; }\n"), "scss", "a.scss", result)
	if len(result.Symbols) != 2 {
		t.Fatalf("symbols = %#v", result.Symbols)
	}
	card, double := result.Symbols[0], result.Symbols[1]
	if card.Name != "card" || card.Kind != "function" || card.LineStart != 1 || card.LineEnd != 4 {
		t.Errorf("card = %#v", card)
	}
	if double.Name != "double" || double.LineStart != 6 || double.LineEnd != 6 {
		t.Errorf("double = %#v", double)
	}
	plain := &Result{}
	parseStylesheet([]byte(".rule { color: blue; }\n"), "css", "a.css", plain)
	if len(plain.Symbols) != 0 {
		t.Errorf("plain CSS has no symbols, got %#v", plain.Symbols)
	}
}
