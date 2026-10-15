"""Stateless requests must work independently and remove all temporary files."""
import base64
import io
import json
from pathlib import Path

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from firewatch.web import vercel_app
from synthetic import make_scene


def png(array):
    stream = io.BytesIO()
    Image.fromarray(array).save(stream, format="PNG")
    return stream.getvalue()


def test_stateless_flow_returns_real_assets_and_cleans_up(monkeypatch, tmp_path):
    temporary_directory = vercel_app.TemporaryDirectory
    directories = []

    def temporary(**kwargs):
        directory = temporary_directory(dir=tmp_path, **kwargs)
        directories.append(Path(directory.name))
        return directory

    monkeypatch.setattr(vercel_app, "TemporaryDirectory", temporary)
    swir, tc, _ = make_scene(smoke=True)
    with TestClient(vercel_app.app) as client:
        first = client.post("/api/uploads", files={"file": ("swir.png", png(swir), "image/png")})
        assert first.status_code == 201
        info = first.json()
        assert info["preview"].startswith("data:image/png;base64,")
        assert all(not directory.exists() for directory in directories)

    # A new client has no state from the inspection request.
    with TestClient(vercel_app.app) as client:
        response = client.post("/api/process", data={"options": json.dumps({
            "swir": info["id"], "truecolor": "tc", "max_side": 1000,
        })}, files={"swir": ("swir.png", png(swir), "image/png"),
                   "truecolor": ("tc.png", png(tc), "image/png")})
        assert response.status_code == 200, response.text
        payload = response.json()
        result = payload["job"]["result"]
        assert payload["job"]["status"] == "completed"
        assert result["report"]["burned_pixels"] > 0
        assert result["report"]["hotspots"]
        assert set(payload["assets"]) == set(result["files"])
        assert json.loads(base64.b64decode(payload["assets"]["report.json"])) == result["report"]
        mask = Image.open(io.BytesIO(base64.b64decode(payload["assets"]["mask-burned.png"])))
        assert mask.width == result["report"]["width"]
        assert response.headers["cache-control"] == "no-store"
        assert client.get(f"/api/analyses/{payload['job']['id']}").status_code == 404
    assert all(not directory.exists() for directory in directories)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("options,files,code", [
    ({}, {}, 422),
    ({"swir": "one"}, {}, 422),
    ({"swir": "same", "truecolor": "same"}, {"swir": b"x", "truecolor": b"x"}, 400),
    ({"swir": "one"}, {"swir": b"not an image"}, 415),
])
def test_invalid_process_requests(options, files, code):
    with TestClient(vercel_app.app) as client:
        response = client.post("/api/process", data={"options": json.dumps(options)},
                               files={kind: ("image.png", body, "image/png") for kind, body in files.items()})
        assert response.status_code == code
        assert "code" in response.json()


def test_combined_request_limit_is_enforced_before_processing(monkeypatch):
    monkeypatch.setattr(vercel_app, "MAX_UPLOAD_BYTES", 10)
    with TestClient(vercel_app.app) as client:
        response = client.post("/api/process", data={"options": '{"swir":"a","truecolor":"b"}'},
                               files={"swir": ("a.png", b"123456"), "truecolor": ("b.png", b"123456")})
        assert response.status_code == 413
        assert response.json() == {"code": "request_too_large"}


def test_failed_processing_also_removes_temporary_files(monkeypatch, tmp_path):
    temporary_directory = vercel_app.TemporaryDirectory
    monkeypatch.setattr(vercel_app, "TemporaryDirectory", lambda **kwargs: temporary_directory(dir=tmp_path, **kwargs))

    def fail(*args):
        raise RuntimeError("Engine failure")

    monkeypatch.setattr(vercel_app, "run_analysis", fail)
    swir, _, _ = make_scene()
    with TestClient(vercel_app.app) as client:
        response = client.post("/api/process", data={"options": '{"swir":"a"}'},
                               files={"swir": ("swir.png", png(swir), "image/png")})
        assert response.json()["job"]["status"] == "failed"
        assert response.json()["assets"] == {}
    assert list(tmp_path.iterdir()) == []
