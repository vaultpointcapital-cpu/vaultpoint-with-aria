"""_compute_value_score is a pure function — the composite score PRD §5
weights. Covers the missing-data weight-redistribution decision (a
Pods-only user with no Aria exposure isn't penalized for it) and the
alert_action_rate substitution for the PRD's unbuildable alert_pnl_saved
(see value_ledger_rollup.py's own docstrings for why)."""

from app.value_ledger_rollup import _compute_value_score


def test_feature_adoption_only_when_nothing_else_present():
    score = _compute_value_score(
        active_pods=[],
        alerts_fired=0,
        alerts_acted_on=0,
        aria_winrate=None,
        aria_count=0,
        time_to_first_value_days=None,
        feature_adoption_rate=0.0,
    )
    assert score == 0.0


def test_pods_only_user_not_penalized_for_missing_aria_and_alerts():
    # No alerts, no Aria trades — those two weights (0.25 + 0.25) must be
    # redistributed across pod_goal_progress/time_to_first_value/feature_adoption,
    # not silently zeroed, per the missing-data redistribution decision.
    full_pod_progress = _compute_value_score(
        active_pods=[{"current_amount": 100, "target_amount": 100}],
        alerts_fired=0,
        alerts_acted_on=0,
        aria_winrate=None,
        aria_count=0,
        time_to_first_value_days=None,
        feature_adoption_rate=0.0,
    )
    # pod_goal_progress (weight redistributed up from 0.20) is the only
    # contributing signal besides the always-present, zeroed
    # feature_adoption and time_to_first_value — score should be well
    # above 0, not crushed by the two "missing" components.
    assert full_pod_progress > 30


def test_perfect_score_when_every_signal_maxed():
    score = _compute_value_score(
        active_pods=[{"current_amount": 100, "target_amount": 100}],
        alerts_fired=10,
        alerts_acted_on=10,
        aria_winrate=1.0,
        aria_count=5,
        time_to_first_value_days=0,
        feature_adoption_rate=1.0,
    )
    assert score == 100.0


def test_alert_action_rate_drives_the_alert_component():
    zero_action = _compute_value_score(
        active_pods=[],
        alerts_fired=10,
        alerts_acted_on=0,
        aria_winrate=None,
        aria_count=0,
        time_to_first_value_days=None,
        feature_adoption_rate=0.0,
    )
    full_action = _compute_value_score(
        active_pods=[],
        alerts_fired=10,
        alerts_acted_on=10,
        aria_winrate=None,
        aria_count=0,
        time_to_first_value_days=None,
        feature_adoption_rate=0.0,
    )
    assert full_action > zero_action


def test_time_to_first_value_degrades_to_zero_not_excluded():
    # Unlike the other components, "no first value yet" contributes 0
    # rather than being excluded from the weighted sum — so a user with
    # only feature_adoption and no first-value-yet scores lower than one
    # who already reached first value, all else equal.
    no_first_value = _compute_value_score(
        active_pods=[],
        alerts_fired=0,
        alerts_acted_on=0,
        aria_winrate=None,
        aria_count=0,
        time_to_first_value_days=None,
        feature_adoption_rate=0.5,
    )
    reached_immediately = _compute_value_score(
        active_pods=[],
        alerts_fired=0,
        alerts_acted_on=0,
        aria_winrate=None,
        aria_count=0,
        time_to_first_value_days=0,
        feature_adoption_rate=0.5,
    )
    assert reached_immediately > no_first_value
