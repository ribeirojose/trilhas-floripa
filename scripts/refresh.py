#!/usr/bin/env python3
"""Rebuild trails.geojson from OpenStreetMap for Grande Florianópolis.

Run occasionally (not at page load) to refresh the committed trail geometry:

    python3 scripts/refresh.py               # fetch from Overpass, then rebuild
    python3 scripts/refresh.py --from-cache  # re-annotate the existing file

Scope is the IBGE mesorregião "Grande Florianópolis" (21 municípios), not just
the island. Each trail gets the município it sits in (point-in-polygon against
data/municipios.geojson) and a coarse zone of the island for the sidebar.

The Overpass API rate-limits aggressively; on failure the existing
trails.geojson is left untouched.
"""

import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "trails.geojson"
MUNIS = ROOT / "data" / "municipios.geojson"
OVERPASS = "https://overpass-api.de/api/interpreter"

# Bounding box for Santa Catarina, slightly padded. Bigger than the island
# on purpose: the good trails run up the coast to Bombinhas and inland to the
# Serra do Tabuleiro and Vale do Itajaí.
BBOX = (-29.40, -53.90, -25.90, -48.20)

# Urban street furniture that OSM tags as footway but is not a trail.
DENY = re.compile(
    r"^(rua|avenida|alameda|travessa|travess|servid|beco|vila|ponte|trapiche"
    r"|galeria|estrada|ciclovia|passeio|passagem|via de|viela|escadaria"
    r"|escadinha|praça|salão|acesso|boulevard|calçadão|primeira|ladeira"
    r"|rodovia|rampa|trevo|retorno|condomínio|condominio|jardim|parque linear"
    r"|calçada|passarela)",
    re.I,
)

KEEP = re.compile(
    r"(trilha|trekking|picada|caminho|trilho|morro|pico|cachoeira|dunas"
    r"|canyon|cânion|gruta|caverna|pedra|serra|sertão|encosta|costão)",
    re.I,
)

TRAIL_NAME = re.compile(r"(trilha|trekking|picada|trilho)", re.I)

SAC_SCALE = {
    "hiking": "easy",
    "mountain_hiking": "medium",
    "demanding_mountain_hiking": "difficult",
    "alpine_hiking": "difficult",
}

# --- Zones -------------------------------------------------------------------
# Coarse grouping for the sidebar. "continente" covers every município on the
# mainland (São José, Palhoça, Biguaçu...), the rest splits Ilha de Santa
# Catarina by geography.
ZONE_ORDER = ["norte", "leste", "centro-oeste", "sul", "continente"]

ZONE_LABELS = {
    "norte": "Norte da Ilha",
    "leste": "Leste da Ilha",
    "centro-oeste": "Centro-Oeste da Ilha",
    "sul": "Sul da Ilha",
    "continente": "Continente",
}

LANDSCAPE_LABELS = {
    "litoral": "Litoral",
    "serra": "Serra e Vale",
    "interior": "Interior",
}


# --- Municipality polygons ---------------------------------------------------


def load_municipios() -> list[dict]:
    """Load município polygons, each with a bbox for cheap rejection."""
    data = json.loads(MUNIS.read_text())
    out = []
    for feat in data["features"]:
        geom = feat["geometry"]
        polys = (
            geom["coordinates"]
            if geom["type"] == "MultiPolygon"
            else [geom["coordinates"]]
        )
        flat = [pt for poly in polys for ring in poly for pt in ring]
        out.append(
            {
                "name": feat["properties"]["name"],
                "polys": polys,
                "bbox": (
                    min(p[1] for p in flat),
                    min(p[0] for p in flat),
                    max(p[1] for p in flat),
                    max(p[0] for p in flat),
                ),
            }
        )
    return out


def point_in_ring(lon: float, lat: float, ring: list) -> bool:
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            xin = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < xin:
                inside = not inside
    return inside


def point_in_municipio(lon: float, lat: float, muni: dict) -> bool:
    lat0, lon0, lat1, lon1 = muni["bbox"]
    if not (lat0 <= lat <= lat1 and lon0 <= lon <= lon1):
        return False
    for poly in muni["polys"]:
        # First ring is the exterior; the rest are holes.
        if point_in_ring(lon, lat, poly[0]):
            if not any(point_in_ring(lon, lat, hole) for hole in poly[1:]):
                return True
    return False


def point_to_ring_km(lon: float, lat: float, ring: list) -> float:
    """Rough distance from a point to a polygon ring, in km."""
    best = float("inf")
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        # Project onto the segment, clamped to its ends.
        dx, dy = x2 - x1, y2 - y1
        seg_len_sq = dx * dx + dy * dy
        t = 0.0
        if seg_len_sq > 0:
            t = max(0.0, min(1.0, ((lon - x1) * dx + (lat - y1) * dy) / seg_len_sq))
        px, py = x1 + t * dx, y1 + t * dy
        best = min(best, haversine_km((lat, lon), (py, px)))
    return best


def distance_to_municipio(lon: float, lat: float, muni: dict) -> float:
    best = float("inf")
    for poly in muni["polys"]:
        best = min(best, point_to_ring_km(lon, lat, poly[0]))
    return best


def municipio_of(lon: float, lat: float, municipios: list[dict]) -> str | None:
    """Município containing the point, else the nearest one within 25 km.

    IBGE's intermediate-resolution polygons are coarse (a border can be off by
    a few hundred metres), so coastal and island trails would otherwise fall
    through the gap. Returning None means the point is outside Santa Catarina
    (or in the ocean), and the caller drops it.
    """
    for muni in municipios:
        if point_in_municipio(lon, lat, muni):
            return muni["name"]

    nearest, best_km = None, 25.0
    for muni in municipios:
        km = distance_to_municipio(lon, lat, muni)
        if km < best_km:
            nearest, best_km = muni["name"], km
    return nearest


def zone_of(lon: float, lat: float, municipio: str | None) -> str:
    """Ilha de Santa Catarina splits by compass; everything else is continente."""
    if municipio != "Florianópolis":
        return "continente"
    # Rough island bounds: lat -27.37 (north) to -27.90 (south),
    # lon -48.62 (west) to -48.35 (east).
    if lat > -27.50:
        return "norte"
    if lat < -27.66:
        return "sul"
    if lon > -48.465:
        return "leste"
    return "centro-oeste"


# Landscape beyond the island: coastal, mountain, or interior. Keeps the
# sidebar useful once it covers all of Santa Catarina, not only the island.
COASTAL = {
    "Bombinhas",
    "Porto Belo",
    "Itapema",
    "Balneário Camboriú",
    "Itajaí",
    "Navegantes",
    "Penha",
    "Piçarras",
    "Barra Velha",
    "São Francisco do Sul",
    "Governador Celso Ramos",
    "Tijucas",
    "Palhoça",
    "São José",
    "Garopaba",
    "Imbituba",
    "Laguna",
    "Jaguaruna",
}

SERRANO = {
    "Santo Amaro da Imperatriz",
    "São Pedro de Alcântara",
    "Águas Mornas",
    "Anitápolis",
    "Rancho Queimado",
    "Alfredo Wagner",
    "São Bonifácio",
    "Angelina",
    "Major Gercino",
    "Leoberto Leal",
    "Nova Trento",
    "Canelinha",
    "São João Batista",
    "Benedito Novo",
    "Rio dos Cedros",
    "Timbó",
    "Ibirama",
    "Apiúna",
    "Ascurra",
    # Vale do Itajaí — Atlantic forest ridges, hit by the same crowd.
    "Blumenau",
    "Indaial",
    "Gaspar",
    "Guabiruba",
    "Brusque",
    "Botuverá",
    "Vidal Ramos",
    "Ituporanga",
    "Petrolândia",
    "Santa Rosa de Lima",
}

# Municípios with coastline outside the mesorregião.
COASTAL |= {
    "Bombinhas",
    "Porto Belo",
    "Camboriú",
    "Balneário Camboriú",
    "Itajaí",
    "Navegantes",
    "Penha",
    "Piçarras",
    "Barra Velha",
    "São Francisco do Sul",
    "Garopaba",
    "Imbituba",
    "Laguna",
    "Jaguaruna",
}


def landscape_of(municipio: str | None) -> str:
    if municipio in COASTAL:
        return "litoral"
    if municipio in SERRANO:
        return "serra"
    return "interior"


# --- Fetch -------------------------------------------------------------------


def fetch() -> dict:
    bbox = ",".join(map(str, BBOX))
    query = (
        "[out:json][timeout:300];"
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
    with urllib.request.urlopen(req, timeout=420) as resp:
        return json.load(resp)


# --- Build -------------------------------------------------------------------


def name_allowed(name: str) -> bool:
    return bool(name) and not DENY.match(name.strip())


def is_trail(tags: dict) -> bool:
    name = tags.get("name") or ""
    if not name_allowed(name):
        return False
    return bool(
        KEEP.search(name) or tags.get("route") == "hiking" or tags.get("sac_scale")
    )


def lines_of(el: dict) -> list[list[tuple[float, float]]]:
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
    """Same-name segments under 4 km apart are one trail; farther apart they are
    genuinely different trails sharing a name."""
    return haversine_km(a, b) < 4.0


def cluster_parts(parts: list[dict]) -> list[list[dict]]:
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


def simplify_line(line: list[tuple[float, float]], tolerance: float = 0.0004) -> list[tuple[float, float]]:
    """Drop points that barely move, by Douglas-Peucker.

    OSM ways carry survey-grade detail (a point every few metres). Shipping all
    of it to the browser costs megabytes for geometry nobody can see at trail
    zoom levels. tolerance is a fraction of a degree (~45 m); it keeps the
    overall shape while cutting the file substantially.

    Points are (lat, lon) tuples.
    """
    if len(line) < 3:
        return line

    def perp_distance(p, a, b) -> float:
        """Degrees from p to segment ab, in the same units as the input."""
        ax, ay = a[0], a[1]
        bx, by = b[0], b[1]
        px, py = p[0], p[1]
        dx, dy = bx - ax, by - ay
        seg_len_sq = dx * dx + dy * dy
        if seg_len_sq == 0:
            return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
        t = ((px - ax) * dx + (py - ay) * dy) / seg_len_sq
        t = max(0.0, min(1.0, t))
        cx, cy = ax + t * dx, ay + t * dy
        return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5

    def dp(points):
        if len(points) < 3:
            return points
        a, b = points[0], points[-1]
        idx, best = 0, 0.0
        for i in range(1, len(points) - 1):
            d = perp_distance(points[i], a, b)
            if d > best:
                idx, best = i, d
        if best > tolerance:
            return dp(points[: idx + 1])[:-1] + dp(points[idx:])
        return [a, b]

    return dp(line)


def build(elements: list, municipios: list[dict]) -> list:
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
        clusters.sort(key=lambda c: (-len(c), c[0]["center"]))

        for index, cluster in enumerate(clusters):
            lines = [
                simplify_line(line)
                for part in cluster
                for line in part["lines"]
            ]
            lines = [line for line in lines if len(line) >= 2]
            coords = [
                [[round(lon, 6), round(lat, 6)] for lat, lon in line] for line in lines
            ]
            lat, lon = centroid(lines)
            trail_name = name if len(clusters) == 1 else f"{name} ({index + 1})"

            merged: dict = {}
            hiking = False
            for part in cluster:
                hiking = hiking or part["hiking"]
                for key in ("sac_scale", "distance", "surface", "operator"):
                    if part["tags"].get(key) and key not in merged:
                        merged[key] = part["tags"][key]

            raw = merged.get("distance")
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

            municipio = municipio_of(lon, lat, municipios)
            # Skip anything outside Santa Catarina: those are clipped by the
            # bbox, so their geometry is broken and unlabeled.
            if not municipio:
                continue
            zone = zone_of(lon, lat, municipio)
            landscape = landscape_of(municipio)

            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "MultiLineString", "coordinates": coords},
                    "properties": {
                        "name": trail_name,
                        "kind": "trilha"
                        if hiking or TRAIL_NAME.search(name)
                        else "caminho",
                        "municipio": municipio,
                        "zone": zone,
                        "zoneLabel": ZONE_LABELS[zone],
                        "landscape": landscape,
                        "landscapeLabel": LANDSCAPE_LABELS[landscape],
                        "difficulty": SAC_SCALE.get(merged.get("sac_scale")),
                        "distanceKm": round(dist, 2),
                        "surface": merged.get("surface"),
                        "operator": merged.get("operator"),
                        "osm": cluster[0]["id"],
                        "osmAll": [part["id"] for part in cluster],
                        "lat": round(lat, 6),
                        "lon": round(lon, 6),
                    },
                }
            )

    return sort_features(features)


def sort_features(features: list) -> list:
    order = {key: i for i, key in enumerate(ZONE_ORDER)}
    features.sort(
        key=lambda f: (
            order.get(f["properties"].get("zone"), 99),
            f["properties"].get("municipio") or "",
            f["properties"]["name"],
        )
    )
    return features


def annotate_cached(features: list, municipios: list[dict]) -> list:
    kept = []
    for f in features:
        props = f["properties"]
        if not name_allowed(props.get("name", "")):
            continue
        lon, lat = props["lon"], props["lat"]
        municipio = municipio_of(lon, lat, municipios)
        if not municipio:
            continue
        props["municipio"] = municipio
        props["zone"] = zone_of(lon, lat, municipio)
        props["zoneLabel"] = ZONE_LABELS[props["zone"]]
        props["landscape"] = landscape_of(municipio)
        props["landscapeLabel"] = LANDSCAPE_LABELS[props["landscape"]]
        kept.append(f)
    return sort_features(kept)


# --- CLI ---------------------------------------------------------------------


def main(argv: list[str]) -> int:
    municipios = load_municipios()
    from_cache = "--from-cache" in argv

    if from_cache:
        payload = json.loads(OUT.read_text())
        features = annotate_cached(payload.get("features", []), municipios)
        payload["features"] = features
        meta = payload.setdefault("metadata", {})
        meta["count"] = len(features)
        meta["zones"] = [ZONE_LABELS[k] for k in ZONE_ORDER]
        meta["municipios"] = sorted(
            {f["properties"]["municipio"] for f in features if f["properties"]["municipio"]}
        )
        OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        print(f"{len(features)} trilhas (cache) -> {OUT}")
        return 0

    try:
        data = fetch()
    except Exception as exc:
        print(f"Overpass fetch failed: {exc}", file=sys.stderr)
        print("Existing trails.geojson left untouched.", file=sys.stderr)
        return 1

    features = build(data.get("elements", []), municipios)
    payload = {
        "type": "FeatureCollection",
        "metadata": {
            "generated": date.today().isoformat(),
            "source": "OpenStreetMap ODbL",
            "bbox": list(BBOX),
            "count": len(features),
            "zones": [ZONE_LABELS[k] for k in ZONE_ORDER],
            "municipios": sorted(
                {f["properties"]["municipio"] for f in features if f["properties"]["municipio"]}
            ),
            "counts": {
                "landscape": dict(
                    sorted(
                        __import__("collections").Counter(
                            f["properties"]["landscape"] for f in features
                        ).items()
                    )
                ),
                "zone": dict(
                    sorted(
                        __import__("collections").Counter(
                            f["properties"]["zone"] for f in features
                        ).items()
                    )
                ),
            },
        },
        "features": features,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(features)} trilhas -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
