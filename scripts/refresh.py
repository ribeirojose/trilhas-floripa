#!/usr/bin/env python3
"""Rebuild trails.geojson from OpenStreetMap.

Run occasionally (not at page load) to refresh the committed trail geometry:

    python3 scripts/refresh.py

Emits real line geometry so the map draws trails as routes, not pins.
Filters out urban features (ruas, servidões, travessas, escadarias) that OSM
also tags as footways, keeping only named paths that look like real trails.
"""

import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

BBOX = (-27.95, -48.75, -27.25, -48.20)  # Grande Florianópolis
OVERPASS = "https://overpass-api.de/api/interpreter"
OUT = Path(__file__).resolve().parent.parent / "trails.geojson"

# Urban street furniture that OSM tags as footway but is not a trail.
DENY = re.compile(
    r"^(rua|avenida|alameda|travessa|travess|servid|beco|vila|ponte|trapiche"
    r"|galeria|estrada|ciclovia|passeio|passagem|via de|viela|escadaria"
    r"|escadinha|praça|salão|acesso|boulevard|calçadão|primeira)\b",
    re.I,
)

# Positive signals for an actual trail.
KEEP = re.compile(r"(trilha|trekking|picada|caminho|trilho|morro|pico|cachoeira|dunas)", re.I)

# Names that read as an actual trail (vs. a path/caminho).
TRAIL_NAME = re.compile(r"(trilha|trekking|picada|trilho)", re.I)

SAC_SCALE = {
    "hiking": "easy",
    "mountain_hiking": "medium",
    "demanding_mountain_hiking": "difficult",
    "alpine_hiking": "difficult",
}


def fetch() -> dict:
    bbox = ",".join(map(str, BBOX))
    query = (
        "[out:json][timeout:180];"
        "("
        f'way["highway"~"^(path|footway|track)$"]["name"]({bbox});'
        f'relation["route"="hiking"]["name"]({bbox});'
        ");"
        "out geom tags;"
    )
    req = urllib.request.Request(
        OVERPASS,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "trilhas-floripa/1.0 (trail index refresh)"},
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
        return json.load(resp)


def is_trail(tags: dict) -> bool:
    name = (tags.get("name") or "").strip()
    if not name or DENY.match(name):
        return False
    return bool(
        KEEP.search(name) or tags.get("route") == "hiking" or tags.get("sac_scale")
    )


def lines_of(el: dict) -> list[list[tuple[float, float]]]:
    """Extract coordinate lines from a way or a hiking relation."""
    out = []
    if el.get("geometry"):
        out.append([(p["lat"], p["lon"]) for p in el["geometry"]])
    for member in el.get("members", []):
        if member.get("geometry"):
            out.append([(p["lat"], p["lon"]) for p in member["geometry"]])
    return [line for line in out if len(line) >= 2]


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    from math import asin, cos, radians, sin, sqrt

    lat1, lon1 = map(radians, a)
    lat2, lon2 = map(radians, b)
    h = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * asin(sqrt(h))


def centroid(lines: list[list[tuple[float, float]]]) -> tuple[float, float]:
    flat = [pt for line in lines for pt in line]
    return (
        sum(p[0] for p in flat) / len(flat),
        sum(p[1] for p in flat) / len(flat),
    )


def same_place(a: tuple[float, float], b: tuple[float, float]) -> bool:
    """Centroids closer than this are treated as one trail. Farther apart are
    genuinely different trails that share a name (e.g. two 'Trilha do Farol'
    29 km apart)."""
    return haversine_km(a, b) < 4.0


def cluster_parts(parts: list[dict]) -> list[list[dict]]:
    """Transitive grouping: a long trail whose segments string out over several
    kilometres still collapses into one cluster."""
    parent = list(range(len(parts)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(parts)):
        for j in range(i + 1, len(parts)):
            if same_place(parts[i]["center"], parts[j]["center"]):
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[rj] = ri

    groups: dict[int, list[dict]] = {}
    for i, part in enumerate(parts):
        groups.setdefault(find(i), []).append(part)
    return list(groups.values())


def build(elements: list) -> list:
    # Group by name first, then split each name into spatial clusters.
    by_name: dict[str, list[dict]] = {}
    for el in elements:
        tags = el.get("tags") or {}
        if not is_trail(tags):
            continue
        lines = lines_of(el)
        if not lines:
            continue
        by_name.setdefault(tags["name"].strip(), []).append(
            {
                "id": f"{el['type']}/{el['id']}",
                "lines": lines,
                "tags": tags,
                "hiking": tags.get("route") == "hiking",
                "center": centroid(lines),
            }
        )

    features = []
    for name, parts in by_name.items():
        clusters = cluster_parts(parts)
        # Stable, readable ordering when a name really is used twice.
        clusters.sort(key=lambda c: (-len(c), c[0]["center"]))

        for index, cluster in enumerate(clusters):
            lines = [line for part in cluster for line in part["lines"]]
            coords = [
                [[round(lon, 6), round(lat, 6)] for lat, lon in line] for line in lines
            ]
            lat, lon = centroid(lines)
            trail_name = name if len(clusters) == 1 else f"{name} ({index + 1})"

            merged_tags: dict = {}
            hiking = False
            for part in cluster:
                hiking = hiking or part["hiking"]
                for key in ("sac_scale", "distance", "surface", "operator"):
                    if part["tags"].get(key) and key not in merged_tags:
                        merged_tags[key] = part["tags"][key]

            raw = merged_tags.get("distance")
            dist = None
            if raw:
                m = re.search(r"\d+(?:[.,]\d+)?", raw)
                if m:
                    dist = float(m.group().replace(",", "."))
            if dist is None:
                dist = sum(
                    haversine_km(line[i], line[i + 1])
                    for line in lines
                    for i in range(len(line) - 1)
                )

            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "MultiLineString", "coordinates": coords},
                    "properties": {
                        "name": trail_name,
                        "kind": "trilha"
                        if hiking or TRAIL_NAME.search(name)
                        else "caminho",
                        "difficulty": SAC_SCALE.get(merged_tags.get("sac_scale")),
                        "distanceKm": round(dist, 2),
                        "surface": merged_tags.get("surface"),
                        "operator": merged_tags.get("operator"),
                        "osm": cluster[0]["id"],
                        "osmAll": [part["id"] for part in cluster],
                        "lat": round(lat, 6),
                        "lon": round(lon, 6),
                    },
                }
            )

    features.sort(key=lambda f: f["properties"]["name"])
    return features


def main() -> int:
    try:
        data = fetch()
    except Exception as exc:  # network/Overpass failure
        print(f"Overpass fetch failed: {exc}", file=sys.stderr)
        return 1

    features = build(data.get("elements", []))
    payload = {
        "type": "FeatureCollection",
        "metadata": {
            "generated": date.today().isoformat(),
            "source": "OpenStreetMap ODbL",
            "bbox": list(BBOX),
            "count": len(features),
        },
        "features": features,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(features)} trilhas -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
