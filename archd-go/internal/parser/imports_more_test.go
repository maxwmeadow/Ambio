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
