"""Guards for the static dashboard: the standalone build and the data the map needs."""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import build_standalone  # noqa: E402
FRONTEND = os.path.join(ROOT, "frontend")


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


def test_standalone_build_extracts_the_dashboard_body():
    body = build_standalone.extract_body(read("frontend", "index.html"))
    for element_id in ("checker", "verdict", "area-map", "versus", "scatter"):
        assert f'id="{element_id}"' in body


def test_dashboard_has_no_third_party_scripts():
    scripts = re.findall(r'<script[^>]*src="([^"]+)"', read("frontend", "index.html"))
    assert scripts == ["app.js"]


def test_area_summary_has_map_coordinates():
    areas = json.loads(read("frontend", "data", "area_summary.json"))
    assert len(areas) == 12
    for row in areas:
        assert 24.9 < row["lat"] < 25.4 and 55.0 < row["lon"] < 55.5, row["area"]
