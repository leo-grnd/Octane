#!/usr/bin/env python3
"""
scripts/build_history.py — pré-calcule l'historique hebdomadaire des prix carburants.

Alternative stdlib-only au script Node (scripts/build-history.mjs).

Source : archives annuelles officielles
  https://donnees.roulez-eco.fr/opendata/annee/YYYY (ZIP → XML)

Le dataset Opendatasoft "prix-des-carburants-fichier-annuel-YYYY" n'est plus publié
sous ce slug côté API ; on repasse par la source amont (fichiers publiés par le
Ministère de l'Économie, mis à jour quotidiennement).

Usage :
  python3 scripts/build_history.py                    # 12 dernières semaines, année en cours
  python3 scripts/build_history.py --weeks 24
  python3 scripts/build_history.py --year 2025        # force une année

Sortie : data/history/<fuel_field>.json
Format : { generated, source, fuel, weeks, stations: { id_pdv: [prix_millieme, ...] } }
Prix stockés en millièmes d'euros (entiers) ou null si pas de donnée pour la semaine.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Nom dans le XML → clé côté client
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


def download_year_zip(year: int) -> bytes:
    """Télécharge l'archive annuelle. Peut renvoyer plusieurs centaines de Mo."""
    url = f"https://donnees.roulez-eco.fr/opendata/annee/{year}"
    req = urllib.request.Request(url, headers={"User-Agent": "octane-builder/1.0"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status}")
        return resp.read()


def extract_xml(zip_bytes: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        xml_name = next((n for n in names if n.lower().endswith(".xml")), None)
        if not xml_name:
            raise RuntimeError(f"Pas de fichier XML dans le ZIP : {names}")
        return zf.read(xml_name)


def parse_price(raw: str | None) -> float | None:
    """`valeur` peut être en euros ('1.789') ou, historiquement, en millièmes ('1789')."""
    if not raw:
        return None
    try:
        p = float(raw)
    except (TypeError, ValueError):
        return None
    if p <= 0:
        return None
    # Heuristique : au-delà de 10 €/L, c'est forcément du millième
    if p > 10:
        p = p / 1000.0
    return p


def parse_maj(raw: str | None) -> datetime | None:
    if not raw:
        return None
    s = raw.strip().replace("T", " ").replace("Z", "")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def aggregate(xml_bytes: bytes, weeks: list[str], fuel_name: str) -> dict[str, list[int | None]]:
    week_idx = {w: i for i, w in enumerate(weeks)}
    buckets: dict[str, list[list[float | int]]] = defaultdict(
        lambda: [[0.0, 0] for _ in range(len(weeks))]
    )
    current_id: str | None = None

    for event, elem in ET.iterparse(io.BytesIO(xml_bytes), events=("start", "end")):
        if event == "start" and elem.tag == "pdv":
            current_id = elem.get("id")
        elif event == "end" and elem.tag == "prix":
            if current_id and elem.get("nom") == fuel_name:
                price = parse_price(elem.get("valeur"))
                d = parse_maj(elem.get("maj"))
                if price is not None and d is not None:
                    idx = week_idx.get(iso_week(d))
                    if idx is not None:
                        slot = buckets[current_id][idx]
                        slot[0] += price
                        slot[1] += 1
            elem.clear()
        elif event == "end" and elem.tag == "pdv":
            current_id = None
            elem.clear()

    stations: dict[str, list[int | None]] = {}
    for id_, slots in buckets.items():
        arr: list[int | None] = [
            round((s[0] / s[1]) * 1000) if s[1] else None for s in slots
        ]
        if any(v is not None for v in arr):
            stations[id_] = arr
    return stations


def try_year(year: int) -> bytes | None:
    try:
        print(f"  ↓ téléchargement annuel {year}…", file=sys.stderr, flush=True)
        zip_bytes = download_year_zip(year)
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        print(f"  ⚠ année {year} indispo ({e})", file=sys.stderr)
        return None
    try:
        xml_bytes = extract_xml(zip_bytes)
    except (zipfile.BadZipFile, RuntimeError) as e:
        print(f"  ⚠ ZIP {year} illisible ({e})", file=sys.stderr)
        return None
    print(f"  ✓ XML {year} : {len(xml_bytes) / 1024 / 1024:.1f} Mo", file=sys.stderr)
    return xml_bytes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--weeks", type=int, default=12)
    parser.add_argument("--year", type=int, default=date.today().year)
    args = parser.parse_args()

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

    # Fallback année précédente si l'annuel courant n'est pas encore publié
    xml_bytes = try_year(args.year)
    used_year = args.year
    if xml_bytes is None:
        xml_bytes = try_year(args.year - 1)
        used_year = args.year - 1
    if xml_bytes is None:
        print(
            f"✗ Impossible de récupérer les archives annuelles {args.year} ni {args.year - 1}",
            file=sys.stderr,
        )
        return 1

    source = f"donnees.roulez-eco.fr/opendata/annee/{used_year}"
    any_success = False
    for api_name, field_key in FUELS.items():
        print(f"\n→ {api_name} ({field_key})", file=sys.stderr)
        stations = aggregate(xml_bytes, weeks, api_name)
        payload = {
            "generated": now.isoformat(),
            "source": source,
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
