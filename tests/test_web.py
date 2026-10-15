"""Image-only HTTP behavior against the real analysis engine."""
import io
import time

import numpy as np
import pytest
from PIL import Image

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient

from firewatch.web.app import create_app
from synthetic import make_scene


def _png(array):
    stream = io.BytesIO()
    Image.fromarray(array).save(stream, format="PNG")
    return stream.getvalue()


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as api:
        yield api


def _upload(client, array, name="scene.png"):
    response = client.post("/api/uploads", files={"file": (name, _png(array), "image/png")})
    assert response.status_code == 201, response.text
    return response.json()


def _complete(client, job_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        response = client.get(f"/api/analyses/{job_id}")
        assert response.status_code == 200
        job = response.json()
        if job["status"] in ("completed", "failed"):
            return job
        time.sleep(0.02)
    pytest.fail("Image analysis did not complete within 30 seconds")


def test_web_analysis_exports_independent_layers_and_preserves_water(client):
    swir, tc, truth = make_scene(smoke=True)
    first = _upload(client, swir, "swir.png")
    second = _upload(client, tc, "tc.png")
    assert first["detected"] == "swir"
    assert client.get(first["preview"]).headers["content-type"] == "image/png"
    response = client.post("/api/analyses", json={"swir": first["id"], "truecolor": second["id"]})
    assert response.status_code == 202
    job = _complete(client, response.json()["id"])
    assert job["status"] == "completed", job
    result = job["result"]
    report = result["report"]
    assert report["burned_pixels"] > 0
    assert report["hotspots"]
    assert report["front_sectors"] > 0
    assert report["probable_pixels"] > 0
    assert report["water_inside_pixels"] > 0
    assert report["islands"] > 0
    assert set(result["layers"]) == {"burned", "perimeter", "under_smoke", "front", "fire", "water", "smoke", "smoke_low"}
    prefix = f"/api/analyses/{job['id']}/files/"
    mask = client.get(prefix + "mask-burned.png")
    pixels = np.asarray(Image.open(io.BytesIO(mask.content))) > 0
    assert not (pixels & truth["water"]).any()
    assert int(pixels.sum()) == report["burned_pixels"]
    assert client.get(prefix + "layer-burned.svg").headers["content-type"].startswith("image/svg+xml")
    downloaded = client.get(prefix + "report.json?download=true")
    assert downloaded.json() == report
    assert "attachment" in downloaded.headers["content-disposition"]
    assert not any("geo" in name.lower() for name in result["files"])
    assert client.get(prefix + "missing.png").status_code == 404


def test_no_fire_scene_has_no_estimated_front_and_no_hotspots(client):
    swir, _, _ = make_scene(burned=False, edge_fire=False, isolated_hot=False)
    image = _upload(client, swir)
    started = client.post("/api/analyses", json={"swir": image["id"]})
    job = _complete(client, started.json()["id"])
    assert job["status"] == "completed"
    report = job["result"]["report"]
    assert not report["detected"]
    assert report["front_sectors"] == 0
    assert report["hotspots"] == []
    assert "no_truecolor" in report["notes"]


@pytest.mark.parametrize("payload,code", [
    ({}, 422), ({"swir": "missing"}, 404),
    ({"swir": "missing", "bbox": [0, 0, 1, 1]}, 422),
    ({"swir": "missing", "max_side": 0}, 422),
    ({"swir": "missing", "sensitivity": "unknown"}, 422),
])
def test_invalid_or_geographic_analysis_options_are_rejected(client, payload, code):
    assert client.post("/api/analyses", json=payload).status_code == code


def test_duplicate_compositions_are_rejected(client):
    image = _upload(client, make_scene()[0])
    response = client.post("/api/analyses", json={"swir": image["id"], "truecolor": image["id"]})
    assert response.status_code == 400
    assert response.json()["code"] == "duplicate_image"


@pytest.mark.parametrize("content", [b"not an image", b"\x89PNG\r\n\x1a\ninvalid"])
def test_invalid_images_return_a_translatable_error_and_leave_no_files(tmp_path, content):
    with TestClient(create_app(tmp_path)) as client:
        response = client.post("/api/uploads", files={"file": ("scene.png", content, "image/png")})
        assert response.status_code == 415
        assert response.json() == {"code": "invalid_image"}
    assert list(tmp_path.iterdir()) == []


def test_upload_limit_removes_partial_input(tmp_path):
    with TestClient(create_app(tmp_path, max_upload_bytes=16)) as client:
        response = client.post("/api/uploads", files={"file": ("large.png", b"x" * 20, "image/png")})
        assert response.status_code == 413
        assert response.json()["code"] == "file_too_large"
    assert list(tmp_path.iterdir()) == []


def test_analysis_failure_reaches_a_terminal_state_without_exposing_paths(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        image = _upload(client, make_scene()[0])
        (tmp_path / f"{image['id']}.input").unlink()
        job_id = client.post("/api/analyses", json={"swir": image["id"]}).json()["id"]
        job = _complete(client, job_id)
        assert job["status"] == "failed"
        assert job["error"] == "analysis_failed"
        assert job["result"] is None


def test_app_instances_do_not_share_uploads(tmp_path):
    with TestClient(create_app(tmp_path / "first")) as first:
        image = _upload(first, make_scene()[0])
    with TestClient(create_app(tmp_path / "second")) as second:
        assert second.get(image["preview"]).status_code == 404
