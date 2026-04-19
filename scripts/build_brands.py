#!/usr/bin/env python3
"""
scripts/build_brands.py — scrape OSM pour toutes les stations essence françaises
avec leur marque, ship un JSON côté client. Stdlib only, utile si Node n'est pas
dispo.

Usage :
  python3 scripts/build_brands.py
  python3 scripts/build_brands.py --out data/osm/brands.json

Sortie : data/osm/brands.json
Format : { generated, source, brands: [...], stations: [[lat, lon, brandIdx], ...] }
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

QUERY = """
[out:json][timeout:600];
area["ISO3166-1"="FR"]->.fr;
(
  node["amenity"="fuel"](area.fr);
  way["amenity"="fuel"](area.fr);
);
out center tags;
""".strip()

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def fetch_all() -> dict:
    data = urllib.parse.urlencode({"data": QUERY}).encode("utf-8")
    last_err: Exception | None = None
    for ep in ENDPOINTS:
        print(f"→ {ep}", file=sys.stderr)
        req = urllib.request.Request(
            ep,
            data=data,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "octane-builder/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                if resp.status != 200:
                    print(f"  ✗ HTTP {resp.status}", file=sys.stderr)
                    last_err = RuntimeError(f"HTTP {resp.status}")
                    continue
                return json.loads(resp.read())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            print(f"  ✗ {e}", file=sys.stderr)
            last_err = e
    raise last_err or RuntimeError("Tous les endpoints Overpass ont échoué")


def extract_brand(tags: dict) -> str:
    return (tags.get("brand") or tags.get("operator") or tags.get("name") or "").strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--out", default="data/osm/brands.json")
    args = parser.parse_args()
    out_path = (ROOT / args.out).resolve()

    data = fetch_all()
    elements = data.get("elements", [])
    print(f"Total éléments OSM : {len(elements)}", file=sys.stderr)

    brand_map: dict[str, int] = {}
    stations: list[list] = []
    skipped_no_brand = 0
    skipped_no_coords = 0

    for e in elements:
        lat = e.get("lat")
        lon = e.get("lon")
        if lat is None or lon is None:
            c = e.get("center") or {}
            lat = c.get("lat")
            lon = c.get("lon")
        if lat is None or lon is None:
            skipped_no_coords += 1
            continue
        brand = extract_brand(e.get("tags") or {})
        if not brand:
            skipped_no_brand += 1
            continue
        idx = brand_map.get(brand)
        if idx is None:
            idx = len(brand_map)
            brand_map[brand] = idx
        stations.append([round(lat, 5), round(lon, 5), idx])

    print(f"Stations avec marque : {len(stations)}", file=sys.stderr)
    print(f"  ignorées (sans marque)    : {skipped_no_brand}", file=sys.stderr)
    print(f"  ignorées (sans coords)    : {skipped_no_coords}", file=sys.stderr)
    print(f"Marques uniques : {len(brand_map)}", file=sys.stderr)

    payload = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "source": "OSM Overpass · amenity=fuel · FR",
        "brands": list(brand_map.keys()),
        "stations": stations,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    size_kb = out_path.stat().st_size / 1024
    print(f"✓ {out_path} : {size_kb:.1f} Ko", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
