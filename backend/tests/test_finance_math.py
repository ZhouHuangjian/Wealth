"""Independent business expectations for V2 Appendix A / AT-35, 36, 38, 39."""

from copy import deepcopy
from datetime import date
from decimal import Decimal, getcontext
import unittest

from finance_math import (
    add_months,
    available_cash,
    cashflow_scenario,
    loan_schedule,
    period_profit,
    weighted_average_buy,
    weighted_average_sell,
    xirr,
)


D = Decimal


class DecimalPolicyTests(unittest.TestCase):
    def test_float_nan_and_negative_flows_are_rejected(self):
        for value in (0.1, "NaN", "Infinity", True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                period_profit(value, "1")
        with self.assertRaises(ValueError):
            period_profit("0", "10", "-10")

    def test_local_precision_does_not_modify_callers_context(self):
        original = getcontext().prec
        try:
            getcontext().prec = 6
            result = weighted_average_buy("0", "0", "3", "1", "1")
            self.assertEqual(getcontext().prec, 6)
            self.assertEqual(len(result["average_cost"].as_tuple().digits), 160)
            self.assertEqual(result["total_cost"], D("4"))
        finally:
            getcontext().prec = original


class LoanTests(unittest.TestCase):
    def test_month_end_and_leap_year(self):
        self.assertEqual(add_months("2024-01-31", 1), date(2024, 2, 29))
        self.assertEqual(add_months("2024-01-31", 2), date(2024, 3, 31))
        self.assertEqual(add_months("2024-02-29", 1, anchor_day=31), date(2024, 3, 31))
        self.assertEqual(add_months("2024-02-29", 12), date(2025, 2, 28))
        with self.assertRaises(ValueError):
            add_months("2025-01-31", 1, "strict")

    def test_zero_interest_tail_and_first_due_date(self):
        result = loan_schedule("100", "0", 3, "2025-01-31")
        self.assertEqual(
            [row["due_date"] for row in result["rows"]],
            [date(2025, 1, 31), date(2025, 2, 28), date(2025, 3, 31)],
        )
        self.assertEqual(
            [row["payment"] for row in result["rows"]],
            [D("33.33"), D("33.33"), D("33.34")],
        )
        self.assertEqual(result["totals"]["principal"], D("100"))
        self.assertEqual(result["totals"]["interest"], D("0"))
        self.assertEqual(result["rows"][-1]["closing_balance"], D("0"))

    def test_equal_principal_independent_expected_amounts(self):
        result = loan_schedule("1200", "0.12", 3, "2025-11-30", "equal_principal")
        self.assertEqual(
            [row["interest"] for row in result["rows"]], [D("12"), D("8"), D("4")]
        )
        self.assertEqual(
            [row["payment"] for row in result["rows"]], [D("412"), D("408"), D("404")]
        )
        self.assertEqual(result["totals"]["payment"], D("1224"))

    def test_annuity_known_two_period_result(self):
        # 1000 * .01 * 1.01**2 / (1.01**2 - 1) = 507.5124378...
        result = loan_schedule("1000", "0.12", 2, "2026-01-15")
        self.assertEqual(
            [row["payment"] for row in result["rows"]], [D("507.51"), D("507.51")]
        )
        self.assertEqual(
            [row["principal"] for row in result["rows"]], [D("497.51"), D("502.49")]
        )
        self.assertEqual(result["totals"]["interest"], D("15.02"))

    def test_annuity_large_schedule_and_rounding_conservation(self):
        result = loan_schedule("2100000", "0.03", 360, "2026-10-31")
        self.assertEqual(result["rows"][0]["payment"], D("8853.68"))
        self.assertEqual(result["totals"]["principal"], D("2100000"))
        self.assertEqual(result["rows"][-1]["closing_balance"], D("0"))
        for row in result["rows"]:
            self.assertEqual(
                row["opening_balance"] - row["principal"], row["closing_balance"]
            )
            self.assertEqual(row["principal"] + row["interest"], row["payment"])
            self.assertGreaterEqual(row["principal"], D("0"))

    def test_effective_annual_rate_is_explicit(self):
        result = loan_schedule(
            "1000",
            "0.126825030131969720661201",
            1,
            "2026-01-15",
            rate_basis="effective",
        )
        self.assertEqual(result["rows"][0]["interest"], D("10.00"))
        self.assertEqual(result["rate_basis"], "effective")

    def test_custom_schedule_preserves_lender_dates_and_fees(self):
        custom = [
            {
                "due_date": "2026-01-01",
                "principal": "500",
                "interest": "10",
                "fees": "3",
            },
            {"due_date": "2026-03-08", "principal": "500", "interest": "7"},
        ]
        before = deepcopy(custom)
        result = loan_schedule("1000", "0", 2, "2026-01-01", "custom", custom)
        self.assertEqual(result["totals"]["payment"], D("1020"))
        self.assertEqual(result["rows"][1]["due_date"], date(2026, 3, 8))
        self.assertEqual(custom, before)
        for change in (
            [{**custom[0], "principal": "501"}, custom[1]],
            [custom[0], {**custom[1], "principal": "499"}],
            [custom[0], {**custom[1], "due_date": "2026-01-01"}],
            [{**custom[0], "payment": "999"}, custom[1]],
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                loan_schedule("1000", "0", 2, "2026-01-01", "custom", change)


class InvestmentTests(unittest.TestCase):
    def test_appendix_a1_fund_full_lifecycle_net_profit_4_80(self):
        cash = D("10000")
        debit = D("1000")
        cash -= debit
        in_transit = debit
        self.assertEqual(cash + in_transit, D("10000"))
        purchase = weighted_average_buy("0", "0", "495", "2.00", "10")
        in_transit = D("0")
        self.assertEqual(purchase["total_cost"], D("1000"))
        self.assertEqual(
            cash + in_transit + purchase["quantity"] * D("2.00"), D("9990")
        )
        self.assertEqual(cash + purchase["quantity"] * D("2.02"), D("9999.90"))
        redemption = weighted_average_sell(
            purchase["quantity"], purchase["total_cost"], "495", "2.04", "5"
        )
        self.assertEqual(redemption["net_proceeds"], D("1004.80"))
        self.assertEqual(redemption["realized_profit"], D("4.80"))
        self.assertEqual(redemption["quantity"], D("0"))
        self.assertEqual(redemption["total_cost"], D("0"))
        cash += redemption["net_proceeds"]
        self.assertEqual(cash, D("10004.80"))

    def test_moving_average_fee_and_partial_sale(self):
        purchase = weighted_average_buy("100", "1000", "50", "12", "5")
        self.assertEqual(purchase["total_cost"], D("1605"))
        self.assertEqual(purchase["average_cost"], D("10.7"))
        sold = weighted_average_sell("150", "1605", "30", "15", "2")
        self.assertEqual(sold["released_cost"], D("321"))
        self.assertEqual(sold["realized_profit"], D("127"))
        self.assertEqual(sold["total_cost"], D("1284"))

    def test_unknown_cost_does_not_create_fake_profit(self):
        bought = weighted_average_buy("10", None, "2", "5")
        self.assertIsNone(bought["total_cost"])
        sold = weighted_average_sell("12", None, "12", "6", "1")
        self.assertIsNone(sold["realized_profit"])
        self.assertEqual(sold["net_proceeds"], D("71"))
        with self.assertRaises(ValueError):
            weighted_average_sell("1", "1", "2", "1")

    def test_period_profit_boundary_and_appendix_a4(self):
        self.assertEqual(period_profit("10000", "11200", "1000"), D("200"))
        self.assertEqual(period_profit("10000", "10380", "500"), D("-120"))
        self.assertEqual(period_profit("20000", "19880"), D("-120"))


class XirrTests(unittest.TestCase):
    def assertDecimalNear(self, left, right, tolerance="1e-18"):
        self.assertLess(abs(left - D(right)), D(tolerance))

    def test_one_year_ten_percent_and_negative_return(self):
        result = xirr([("2025-01-01", "-1000"), ("2026-01-01", "1100")])
        self.assertEqual(result["status"], "ok")
        self.assertDecimalNear(result["rate"], "0.1")
        negative = xirr([("2025-01-01", "-1000"), ("2026-01-01", "500")])
        self.assertDecimalNear(negative["rate"], "-0.5")

    def test_act_365_uses_exact_days(self):
        # Leap-year span has 366 days; a 10% gross gain is not exactly 10% ACT/365.
        result = xirr([("2024-01-01", "-100"), ("2025-01-01", "110")])
        self.assertEqual(result["status"], "ok")
        self.assertLess(result["rate"], D("0.1"))
        self.assertGreater(result["rate"], D("0.099"))

    def test_multiple_roots_are_not_reported_as_one_rate(self):
        # -100 + 230/(1+r) - 132/(1+r)^2 = 0 => r=.1 or .2.
        result = xirr(
            [("2025-01-01", "-100"), ("2026-01-01", "230"), ("2027-01-01", "-132")]
        )
        self.assertEqual(result["status"], "multiple_roots")
        self.assertIsNone(result["rate"])
        self.assertEqual(len(result["rates"]), 2)
        self.assertDecimalNear(result["rates"][0], "0.1")
        self.assertDecimalNear(result["rates"][1], "0.2")

    def test_tangent_root_detected_without_a_sign_change(self):
        # -(1 - 1.1/(1+r))**2 has a double zero at .1.
        result = xirr(
            [("2025-01-01", "-100"), ("2026-01-01", "220"), ("2027-01-01", "-121")]
        )
        self.assertEqual(result["status"], "ok")
        self.assertDecimalNear(result["rate"], "0.1")

    def test_all_failure_states_hide_the_rate(self):
        cases = [
            ([], "insufficient_data"),
            ([("2025-01-01", "-100"), ("2025-01-01", "110")], "insufficient_data"),
            ([("2025-01-01", "10"), ("2026-01-01", "20")], "no_solution"),
            (
                [("2025-01-01", "-100"), ("2026-01-01", "100"), ("2027-01-01", "-100")],
                "no_solution",
            ),
        ]
        for flows, status in cases:
            with self.subTest(flows=flows):
                result = xirr(flows)
                self.assertEqual(result["status"], status)
                self.assertIsNone(result["rate"])
        result = xirr([("2025-01-01", "-100"), ("2026-01-01", "110")], max_iterations=1)
        self.assertEqual(result["status"], "not_converged")
        self.assertIsNone(result["rate"])

    def test_same_day_netting_bounded_search_and_short_period_flag(self):
        result = xirr(
            [("2025-01-01", "-200"), ("2025-01-01", "100"), ("2026-01-01", "110")],
            upper_rate="0.05",
        )
        self.assertEqual(result["status"], "no_solution")
        short = xirr([("2025-01-01", "-100"), ("2025-02-01", "101")])
        self.assertTrue(short["short_period"])

    def test_very_small_amount_does_not_become_spurious_boundary_root(self):
        result = xirr([("2025-01-01", "-1e-40"), ("2026-01-01", "1.1e-40")])
        self.assertEqual(result["status"], "ok")
        self.assertDecimalNear(result["rate"], "0.1")


class PlanningTests(unittest.TestCase):
    def test_appendix_a3_frozen_reservation_overlap(self):
        reservations = [
            {"id": "same-money", "amount": "2000", "linked_freeze_amount": "2000"},
            {"id": "living", "amount": "3000"},
        ]
        result = available_cash("10000", "2000", reservations)
        self.assertEqual(result["available"], D("5000"))
        result = available_cash(
            "10000", "2000", reservations + [{"id": "new", "amount": "6000"}]
        )
        self.assertEqual(result["available"], D("-1000"))
        self.assertEqual(result["deficit"], D("1000"))
        paid = available_cash(
            "8000", "0", [{"id": "paid", "amount": "2000", "paid": True}]
        )
        self.assertEqual(paid["available"], D("8000"))

    def test_actual_replaces_same_occurrence_and_does_not_mutate_input(self):
        items = [
            {
                "id": "plan",
                "date": "2026-10-01",
                "amount": "-520",
                "occurrence_id": "loan-1",
            },
            {
                "id": "actual",
                "date": "2026-10-02",
                "amount": "-520",
                "occurrence_id": "loan-1",
                "status": "actual",
            },
            {"id": "salary", "date": "2026-10-15", "amount": "1000"},
        ]
        original = deepcopy(items)
        result = cashflow_scenario("10000", "2026-10-01", "2026-10-31", items)
        self.assertEqual(result["closing_cash"], D("10480"))
        self.assertEqual(result["minimum_balance"], D("9480"))
        self.assertEqual(result["minimum_date"], date(2026, 10, 2))
        self.assertEqual(len(result["rows"]), 2)
        self.assertEqual(items, original)
        self.assertTrue(result["is_forecast"])

    def test_mutually_exclusive_scenarios_start_from_same_balance(self):
        first = cashflow_scenario(
            "10000",
            "2026-01-01",
            "2026-12-31",
            [{"id": "house", "date": "2026-10-01", "amount": "-8000"}],
        )
        second = cashflow_scenario(
            "10000",
            "2026-01-01",
            "2026-12-31",
            [{"id": "car", "date": "2026-10-01", "amount": "-3000"}],
        )
        self.assertEqual(first["closing_cash"], D("2000"))
        self.assertEqual(second["closing_cash"], D("7000"))

    def test_deficit_date_and_out_of_window_actual_match(self):
        items = [
            {"id": "plan", "date": "2026-01-02", "amount": "-20", "occurrence_id": "a"},
            {
                "id": "actual-before-start",
                "date": "2025-12-31",
                "amount": "-20",
                "occurrence_id": "a",
                "status": "actual",
            },
            {"id": "spend", "date": "2026-01-03", "amount": "-150"},
        ]
        result = cashflow_scenario("100", "2026-01-01", "2026-01-31", items)
        self.assertEqual(result["closing_cash"], D("-50"))
        self.assertEqual(result["first_deficit_date"], date(2026, 1, 3))


if __name__ == "__main__":
    unittest.main()
