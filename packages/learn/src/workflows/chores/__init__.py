"""Chore template library.

Each module in this package defines ONE Temporal workflow template that runs
on a per-user schedule. Templates are real Python — they handle control flow,
state, and filtering deterministically. The LLM is consulted only at decision
gates (e.g. "is this anomaly worth notifying the user about?"). Most ticks of
most chores should make ZERO LLM calls.

To add a new template:
1. Create a new module here with a workflow class decorated with @workflow.defn.
2. Export it from this __init__.py and append to ALL_CHORE_TEMPLATES.
3. The class is auto-registered via worker.py importing ALL_CHORE_TEMPLATES.
4. Add a matching entry in src/activities/assign_chores.py (PR 4) so
   assign_initial_chores knows when to instantiate it for a user.
"""
from src.workflows.chores.daily_morning_briefing import DailyMorningBriefingWorkflow
from src.workflows.chores.daily_evening_digest import DailyEveningDigestWorkflow
from src.workflows.chores.subscription_watcher import SubscriptionWatcherWorkflow
from src.workflows.chores.weekly_matter_digest import WeeklyMatterDigestWorkflow
from src.workflows.chores.weekly_money_day import WeeklyMoneyDayBriefWorkflow

ALL_CHORE_TEMPLATES = [
    DailyMorningBriefingWorkflow,
    DailyEveningDigestWorkflow,
    SubscriptionWatcherWorkflow,
    WeeklyMatterDigestWorkflow,
    WeeklyMoneyDayBriefWorkflow,
]

__all__ = [
    "ALL_CHORE_TEMPLATES",
    "DailyMorningBriefingWorkflow",
    "DailyEveningDigestWorkflow",
    "SubscriptionWatcherWorkflow",
    "WeeklyMatterDigestWorkflow",
    "WeeklyMoneyDayBriefWorkflow",
]
