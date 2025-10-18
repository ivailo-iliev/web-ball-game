"""Utility to flatten and log InBet websocket change payloads.

This script is tailored for working with JSON payloads emitted by the
InBet change stream.  The API occasionally sends deeply nested market
structures, so we collect the bits we care about into a small in-memory
store and periodically emit flattened CSV rows.
"""
from __future__ import annotations

import csv
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


EventId = str
MarketKey = Tuple[str, str]


class Store:
    """Keep track of the latest event, market and outcome payloads."""

    def __init__(self) -> None:
        self.events: Dict[EventId, Dict[str, Any]] = {}
        self.markets: Dict[EventId, Dict[MarketKey, Dict[str, Any]]] = {}
        self.outcomes: Dict[EventId, Dict[MarketKey, List[Dict[str, Any]]]] = {}

    def add_event(self, node: Dict[str, Any]) -> None:
        if not isinstance(node, dict):
            return

        event_id = node.get("eventId") or node.get("id")
        if event_id is None:
            return
        event_id = str(event_id)

        src = node.get("source") or node.get("src") or ""
        event_path = node.get("eventPath")
        start_time = node.get("startTime")
        scheduled_time = node.get("scheduledTimeUtc")
        event_date = node.get("eventDate")

        ev = self.events.setdefault(event_id, {"event_id": event_id})
        if src:
            ev["source"] = src
        if event_path:
            ev["eventPath"] = event_path
        if start_time is not None:
            ev["start_time"] = start_time
        if scheduled_time is not None:
            ev["scheduledTimeUtc"] = scheduled_time
        if event_date is not None:
            ev["eventDate"] = event_date

        for k in ("tournamentId", "tournamentPath", "category", "categoryId"):
            if node.get(k) is not None:
                ev[k] = node.get(k)

        # Scores & status only from eventClockStatus (exact path)
        ecs = node.get("eventClockStatus")
        if isinstance(ecs, dict):
            for k in ("homeScore", "awayScore", "totalScore", "matchStatus", "totalElapsedTime"):
                if ecs.get(k) is not None:
                    ev[k] = ecs.get(k)
            # Time fields under eventClock
            if ecs.get("lastUpdate") is not None:
                ev["clockLastUpdate"] = ecs.get("lastUpdate")
            clk = ecs.get("eventClock")
            if isinstance(clk, dict):
                if clk.get("eventTime") is not None:
                    ev["clockEventTime"] = clk.get("eventTime")
                if clk.get("remainingTime") is not None:
                    ev["clockRemainingTime"] = clk.get("remainingTime")
                if clk.get("remainingTimeInPeriod") is not None:
                    ev["clockRemainingTimeInPeriod"] = clk.get("remainingTimeInPeriod")

    def add_markets(self, container: Dict[str, Any], event_hint: Optional[EventId] = None) -> None:
        mkts = container.get("markets")
        if not isinstance(mkts, list):
            return

        for m in mkts:
            if not isinstance(m, dict):
                continue

            market_id = str(m.get("id") or m.get("marketId") or "")
            if not market_id:
                continue

            specifier_value = m.get("marketSpecifier") or ""
            market_template = m.get("marketTemplatePath")
            event_id = str(m.get("eventId") or event_hint or "")
            if not event_id:
                continue

            event_markets = self.markets.setdefault(event_id, {})
            event_markets[(market_id, specifier_value)] = m

            oc_map = self.outcomes.setdefault(event_id, {})
            oc_map[(market_id, specifier_value)] = self._collect_outcomes(m)

    @staticmethod
    def _collect_outcomes(market: Dict[str, Any]) -> List[Dict[str, Any]]:
        outcomes = market.get("outcomes")
        if isinstance(outcomes, list):
            return [oc for oc in outcomes if isinstance(oc, dict)]
        return []

    def ingest(self, payload: Dict[str, Any]) -> None:
        """Update store from a raw payload coming from the websocket."""
        if not isinstance(payload, dict):
            return

        # Events can appear either inline or in a list.
        if isinstance(payload.get("events"), list):
            for event in payload["events"]:
                if isinstance(event, dict):
                    self.add_event(event)
        if isinstance(payload.get("event"), dict):
            self.add_event(payload["event"])

        # Market containers can appear on the root or inside event nodes.
        self.add_markets(payload, payload.get("eventId"))
        if isinstance(payload.get("events"), list):
            for event in payload["events"]:
                if isinstance(event, dict):
                    self.add_markets(event, event.get("eventId") or event.get("id"))


def outcome_label(outcome: Dict[str, Any]) -> str:
    if not isinstance(outcome, dict):
        return ""
    for key in ("label", "name", "outcomeName", "selectionName"):
        if outcome.get(key):
            return str(outcome.get(key))
    # A fallback label based on the outcome id or index.
    if outcome.get("id") is not None:
        return str(outcome.get("id"))
    return ""


def get_odds(outcome: Dict[str, Any]) -> str:
    if not isinstance(outcome, dict):
        return ""
    for key in ("odds", "price", "decimalOdds"):
        if outcome.get(key) not in (None, ""):
            return str(outcome.get(key))
    return ""


def get_line(outcome: Dict[str, Any]) -> str:
    if not isinstance(outcome, dict):
        return ""
    if outcome.get("line") not in (None, ""):
        return str(outcome.get("line"))
    if outcome.get("lineValue") not in (None, ""):
        return str(outcome.get("lineValue"))
    return ""


def get_handicap(outcome: Dict[str, Any]) -> str:
    if not isinstance(outcome, dict):
        return ""
    if outcome.get("handicap") not in (None, ""):
        return str(outcome.get("handicap"))
    if outcome.get("spread") not in (None, ""):
        return str(outcome.get("spread"))
    return ""


def flatten_rows(store: Store) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    for ev_id, ev in store.events.items():
        src = ev.get("source", "")
        event_path = ev.get("eventPath", "")
        start_time = ev.get("start_time", "")
        scheduled_time = ev.get("scheduledTimeUtc", "")
        event_date = ev.get("eventDate", "")
        tournament_id = ev.get("tournamentId", "")
        tournament_path = ev.get("tournamentPath", "")
        category = ev.get("category", "")
        category_id = ev.get("categoryId", "")
        home_score = ev.get("homeScore", "")
        away_score = ev.get("awayScore", "")
        total_score = ev.get("totalScore", "")
        match_status = ev.get("matchStatus", "")
        total_elapsed = ev.get("totalElapsedTime", "")
        # Map 'elapsed' to the raw period clock value
        elapsed_raw = ev.get("clockEventTime", "") if src == "live" else ""
        clock_event_time = ev.get("clockEventTime", "")
        clock_remaining_time = ev.get("clockRemainingTime", "")
        clock_remaining_time_in_period = ev.get("clockRemainingTimeInPeriod", "")
        clock_last_update = ev.get("clockLastUpdate", "")
        mkt_dict = store.markets.get(ev_id, {})
        for (tid, specifier_value), m in mkt_dict.items():
            market_name = m.get("marketTemplatePath")
            outcomes = store.outcomes.get(ev_id, {}).get((tid, specifier_value), [])
            if not outcomes:
                outcomes = m.get("outcomes") if isinstance(m.get("outcomes"), list) else []
            for oc in outcomes:
                row = {
                    "source": src,
                    "event_id": ev_id,
                    "eventPath": event_path,
                    "start_time": start_time,
                    "scheduledTimeUtc": scheduled_time,
                    "eventDate": event_date,
                    "tournamentId": tournament_id,
                    "tournamentPath": tournament_path,
                    "category": category,
                    "categoryId": category_id,
                    "homeScore": home_score,
                    "awayScore": away_score,
                    "totalScore": total_score,
                    "matchStatus": match_status,
                    "totalElapsedTime": total_elapsed,
                    "clockEventTime": clock_event_time,
                    "clockRemainingTime": clock_remaining_time,
                    "clockRemainingTimeInPeriod": clock_remaining_time_in_period,
                    "clockLastUpdate": clock_last_update,
                    "elapsed": elapsed_raw,
                    "market": market_name,
                    "specifier": specifier_value,
                    "leg": outcome_label(oc),
                    "odds": get_odds(oc),
                    "line": get_line(oc),
                    "handicap": get_handicap(oc),
                    "current_timestamp": str(int(time.time())),
                }
                rows.append(row)
    return rows


def ensure_csv_header(path: str) -> None:
    if not Path(path).exists():
        fieldnames = [
            "source",
            "event_id",
            "eventPath",
            "start_time",
            "scheduledTimeUtc",
            "eventDate",
            "tournamentId",
            "tournamentPath",
            "category",
            "categoryId",
            "homeScore",
            "awayScore",
            "totalScore",
            "matchStatus",
            "totalElapsedTime",
            "clockEventTime",
            "clockRemainingTime",
            "clockRemainingTimeInPeriod",
            "clockLastUpdate",
            "elapsed",
            "market",
            "specifier",
            "leg",
            "odds",
            "line",
            "handicap",
            "current_timestamp",
        ]
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()


class ChangeLogger:
    def __init__(self, path: str) -> None:
        self.path = path
        self.last_logged: Dict[Tuple[str, str, str], str] = {}
        ensure_csv_header(self.path)

    def log(self, row: Dict[str, str]) -> None:
        key = (row.get("event_id", ""), row.get("market", ""), row.get("leg", ""))
        cur = row.get("odds", "")
        if self.last_logged.get(key) == cur:
            return
        with open(self.path, "a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow([
                row["source"],
                row["event_id"],
                row["eventPath"],
                row["start_time"],
                row["scheduledTimeUtc"],
                row["eventDate"],
                row["tournamentId"],
                row["tournamentPath"],
                row["category"],
                row["categoryId"],
                row["homeScore"],
                row["awayScore"],
                row["totalScore"],
                row["matchStatus"],
                row["totalElapsedTime"],
                row["clockEventTime"],
                row["clockRemainingTime"],
                row["clockRemainingTimeInPeriod"],
                row["clockLastUpdate"],
                row["elapsed"],
                row["market"],
                row["specifier"],
                row["leg"],
                row["odds"],
                row["line"],
                row["handicap"],
                row["current_timestamp"],
            ])
        self.last_logged[key] = cur


def process_stream(lines: Iterable[str], store: Store, logger: ChangeLogger) -> None:
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        store.ingest(payload)
        for row in flatten_rows(store):
            logger.log(row)


def main(argv: List[str]) -> int:
    if len(argv) < 2:
        print("Usage: python inbet_scrape_changes.py <output_csv>")
        return 1
    output_csv = argv[1]
    store = Store()
    logger = ChangeLogger(output_csv)
    process_stream(sys.stdin, store, logger)
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    raise SystemExit(main(sys.argv))
