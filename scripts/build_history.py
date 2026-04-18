#!/usr/bin/env python3
"""
scripts/build_history.py — pré-calcule l'historique hebdomadaire des prix carburants.

Alternative stdlib-only au script Node (scripts/build-history.mjs), utile quand
GitHub Actions n'est pas de bonne humeur ou en dev local sans Node.

Source : dataset annuel `prix-des-carburants-fichier-annuel-YYYY` (data.economie.gouv.fr).

Usage :
  python3 scripts/build_history.py                    # 12 dernières semaines, année en cours
  python3 scripts/build_history.py --weeks 24
  python3 scripts/build_history.py --year 2025        # force une année
  python3 scripts/build_history.py --dataset nom-custom

Sortie : data/history/<fuel_field>.json
Format : { generated, source, fuel, weeks, stations: { id_pdv: [prix_millieme, ...] } }
Prix stockés en millièmes d'euros (entiers) ou null si pas de donnée pour la semaine.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Nom API (dataset annuel) → clé côté client (dataset temps réel)
FUELS = {
    "Gazole": "gazole_prix",
    "SP95": "sp95_prix",
    "SP95-E10": "sp95_e10_prix",
    "SP98": "sp98_prix",
    "E85": "e85_prix",
    "GPLc": "gplc_prix",
}


def iso_week(d: datetime) -> str:
    year, week, _ = d.isocalendar()
    return f"{year}-W{week:02d}"


def week_list(since: datetime, now: datetime, weeks: int) -> list[str]:
    out: list[str] = []
    cursor = since
    for _ in range(weeks):
        out.append(iso_week(cursor))
        cursor += timedelta(days=7)
    last = iso_week(now)
    if not out or out[-1] != last:
        out.append(last)
    seen: set[str] = set()
    deduped: list[str] = []
    for w in out:
        if w not in seen:
            seen.add(w)
            deduped.append(w)
    return deduped


def fetch_export(dataset: str, fuel_name: str, since_iso: str) -> list[dict]:
    params = {
        "select": "id_pdv, prix_valeur, prix_maj",
        "where": f'prix_nom = "{fuel_name}" AND prix_maj >= date\'{since_iso}\'',
        "limit": "-1",
    }
    url = (
        f"https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/"
        f"{dataset}/exports/json?{urllib.parse.urlencode(params)}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "octane-builder/1.0"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status} on {dataset}")
        return json.loads(resp.read())


def aggregate(rows: list[dict], weeks: list[str]) -> dict[str, list[int | None]]:
    week_idx = {w: i for i, w in enumerate(weeks)}
    buckets: dict[str, list[list[float | int]]] = defaultdict(
        lambda: [[0.0, 0] for _ in range(len(weeks))]
    )
    for r in rows:
        id_ = r.get("id_pdv")
        if id_ is None:
            continue
        try:
            price = float(r.get("prix_valeur"))
        except (TypeError, ValueError):
            continue
        if price <= 0 or price != price:  # reject NaN
            continue
        maj = r.get("prix_maj")
        if not maj:
            continue
        try:
            d = datetime.fromisoformat(str(maj).replace("Z", "+00:00"))
        except ValueError:
            continue
        idx = week_idx.get(iso_week(d))
        if idx is None:
            continue
        slot = buckets[str(id_)][idx]
        slot[0] += price
        slot[1] += 1

    stations: dict[str, list[int | None]] = {}
    for id_, slots in buckets.items():
        arr: list[int | None] = [
            round((s[0] / s[1]) * 1000) if s[1] else None for s in slots
        ]
        if any(v is not None for v in arr):
            stations[id_] = arr
    return stations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--weeks", type=int, default=12)
    parser.add_argument("--year", type=int, default=date.today().year)
    parser.add_argument("--dataset", default=None, help="Surcharge le nom du dataset")
    args = parser.parse_args()

    dataset = args.dataset or f"prix-des-carburants-fichier-annuel-{args.year}"
    fallback = f"prix-des-carburants-fichier-annuel-{args.year - 1}"

    now = datetime.now(timezone.utc)
    since = now - timedelta(weeks=args.weeks)
    since_iso = since.date().isoformat()
    weeks = week_list(since, now, args.weeks)

    out_dir = ROOT / "data" / "history"
    out_dir.mkdir(parents=True, exist_ok=True)

    print(
        f"Période : {since_iso} → {now.date().isoformat()} ({len(weeks)} semaines)",
        file=sys.stderr,
    )

    any_success = False
    for api_name, field_key in FUELS.items():
        print(f"\n→ {api_name} ({field_key})", file=sys.stderr)
        used_dataset = dataset
        rows: list[dict] | None = None
        try:
            rows = fetch_export(dataset, api_name, since_iso)
        except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError) as e:
            print(
                f"  ⚠ {dataset} a échoué ({e}), fallback {fallback}",
                file=sys.stderr,
            )
            used_dataset = fallback
            try:
                rows = fetch_export(fallback, api_name, since_iso)
            except Exception as e2:  # noqa: BLE001
                print(f"  ✗ {field_key} : {e2}", file=sys.stderr)
                continue

        stations = aggregate(rows or [], weeks)
        payload = {
            "generated": now.isoformat(),
            "source": used_dataset,
            "fuel": api_name,
            "weeks": weeks,
            "stations": stations,
        }
        out = out_dir / f"{field_key}.json"
        out.write_text(json.dumps(payload, separators=(",", ":")))
        size_kb = out.stat().st_size / 1024
        print(
            f"  ✓ {field_key}.json : {len(stations)} stations, {size_kb:.1f} Ko",
            file=sys.stderr,
        )
        any_success = True

    return 0 if any_success else 1


if __name__ == "__main__":
    sys.exit(main())
