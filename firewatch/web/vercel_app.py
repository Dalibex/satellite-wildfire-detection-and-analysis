"""Stateless Vercel endpoints: temporary inputs, one request, browser-owned results."""
from __future__ import annotations

import base64
import json
import logging
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from PIL import UnidentifiedImageError
from pydantic import ValidationError

from .app import AnalysisRequest, JobResponse, UploadInfo, _inspect_image, run_analysis

MAX_UPLOAD_BYTES = 4 * 1024 * 1024
LOG = logging.getLogger(__name__)
app = FastAPI(title="Firewatch Stateless API", version="0.1.0")


@app.exception_handler(HTTPException)
async def http_error(_request: Request, error: HTTPException) -> JSONResponse:
    return JSONResponse({"code": error.detail}, status_code=error.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, _error: RequestValidationError) -> JSONResponse:
    return JSONResponse({"code": "invalid_request"}, status_code=422)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "max_upload_bytes": MAX_UPLOAD_BYTES, "execution": "stateless"}


async def read_upload(file: UploadFile, remaining: int) -> bytes:
    body = await file.read(remaining + 1)
    if len(body) > remaining:
        raise HTTPException(413, "request_too_large")
    return body


def inspect(body: bytes, filename: str, directory: Path, index: int) -> tuple[UploadInfo, Path]:
    target, preview = directory / f"input-{index}", directory / f"preview-{index}.png"
    target.write_bytes(body)
    try:
        width, height, kind = _inspect_image(target, preview)
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(415, "invalid_image") from None
    info = UploadInfo(id=uuid4().hex, name=Path(filename).name[:160], width=width,
                      height=height, bytes=len(body), detected=kind,
                      preview="data:image/png;base64," + base64.b64encode(preview.read_bytes()).decode())
    return info, target


@app.post("/api/uploads", response_model=UploadInfo, status_code=201)
async def upload(file: UploadFile = File(...)) -> UploadInfo:
    """Inspect only; the browser keeps the original file for the analysis request."""
    try:
        body = await read_upload(file, MAX_UPLOAD_BYTES)
        return await run_in_threadpool(inspect_upload, body, file.filename or "image")
    finally:
        await file.close()


def inspect_upload(body: bytes, filename: str) -> UploadInfo:
    with TemporaryDirectory(prefix="firewatch-inspect-") as temporary:
        info, _ = inspect(body, filename, Path(temporary), 0)
        return info


def process(options: AnalysisRequest, files: dict[str, tuple[str, bytes]]) -> dict:
    with TemporaryDirectory(prefix="firewatch-process-") as temporary:
        directory = Path(temporary)
        paths, inputs = [], {}
        for index, kind in enumerate(("swir", "truecolor", "wildfire")):
            if kind not in files:
                paths.append(None)
                continue
            name, body = files[kind]
            info, path = inspect(body, name, directory, index)
            info.id = getattr(options, kind)
            inputs[kind] = info.model_dump()
            paths.append(path)
        job_id = uuid4().hex
        try:
            result = run_analysis(options, paths, directory)
            result["inputs"] = inputs
            assets = {filename: base64.b64encode((directory / filename).read_bytes()).decode()
                      for filename in result["files"]}
            job = JobResponse(id=job_id, status="completed", stage="completed", result=result)
            return {"job": job.model_dump(), "assets": assets}
        except Exception:
            LOG.exception("Analysis %s failed", job_id)
            job = JobResponse(id=job_id, status="failed", stage="failed", error="analysis_failed")
            return {"job": job.model_dump(), "assets": {}}
        # TemporaryDirectory removes all inputs and outputs before returning the response.


@app.post("/api/process")
async def analyze_images(options: str = Form(...), swir: UploadFile | None = File(None),
                         truecolor: UploadFile | None = File(None),
                         wildfire: UploadFile | None = File(None)) -> StreamingResponse:
    uploads = {"swir": swir, "truecolor": truecolor, "wildfire": wildfire}
    try:
        try:
            parsed = AnalysisRequest.model_validate_json(options)
        except ValidationError:
            raise HTTPException(422, "invalid_request") from None
        selected = [getattr(parsed, kind) for kind in uploads if getattr(parsed, kind)]
        if len(set(selected)) != len(selected):
            raise HTTPException(400, "duplicate_image")
        if any(bool(file) != bool(getattr(parsed, kind)) for kind, file in uploads.items()):
            raise HTTPException(422, "invalid_request")
        files, remaining = {}, MAX_UPLOAD_BYTES
        for kind, file in uploads.items():
            if file is not None:
                body = await read_upload(file, remaining)
                remaining -= len(body)
                files[kind] = (file.filename or "image", body)
        response = await run_in_threadpool(process, parsed, files)
    finally:
        for file in uploads.values():
            if file is not None:
                await file.close()

    def chunks():
        # Chunked responses can exceed Vercel's buffered-response limit.
        for part in json.JSONEncoder(ensure_ascii=False).iterencode(response):
            encoded = part.encode("utf-8")
            for offset in range(0, len(encoded), 64 * 1024):
                yield encoded[offset:offset + 64 * 1024]

    return StreamingResponse(chunks(), media_type="application/json",
                             headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
