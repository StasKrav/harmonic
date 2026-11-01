"""HARMONIC API. Keeps POST /analyze -> {chords:[{chord,time,duration}]} compatible."""
import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

try:
    from mutagen import File as MutagenFile
except ImportError:
    MutagenFile = None

from chord_extractor.extractors import Chordino

MAX_UPLOAD_BYTES = 50 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024
MAX_AUDIO_SECONDS = 60 * 60
MIN_DURATION = 0.8
QUEUE_CAPACITY = 3
ALLOWED_SUFFIXES = {".mp3", ".wav", ".wave", ".m4a", ".mp4", ".ogg", ".oga", ".flac", ".aac", ".webm"}

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("harmonic.api")
chordino = Chordino(roll_on=1)
job_queue: asyncio.Queue | None = None
worker_task: asyncio.Task | None = None


def has_audio_signature(path: str, suffix: str) -> bool:
    with open(path, "rb") as stream:
        head = stream.read(64)
    if suffix in {".wav", ".wave"}:
        return len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    if suffix == ".flac":
        return head.startswith(b"fLaC")
    if suffix in {".ogg", ".oga"}:
        return head.startswith(b"OggS")
    if suffix == ".webm":
        return head.startswith(bytes.fromhex("1A45DFA3"))
    if suffix in {".m4a", ".mp4"}:
        return len(head) >= 12 and head[4:8] == b"ftyp"
    if suffix == ".aac":
        return len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xF6) == 0xF0
    if suffix == ".mp3":
        return head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)
    return False


def probe_duration(path: str) -> float:
    """Read exact media duration (Mutagen -> ffprobe -> stdlib WAV)."""
    if MutagenFile is not None:
        try:
            audio = MutagenFile(path)
            length = float(audio.info.length) if audio and audio.info else 0.0
            if length > 0:
                return length
        except Exception:
            logger.debug("Mutagen could not read duration", exc_info=True)
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        try:
            result = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", path],
                check=True, capture_output=True, text=True, timeout=20)
            length = float(result.stdout.strip())
            if length > 0:
                return length
        except (subprocess.SubprocessError, ValueError, OSError):
            logger.debug("ffprobe could not read duration", exc_info=True)
    try:
        import wave
        with wave.open(path, "rb") as wav:
            length = wav.getnframes() / float(wav.getframerate())
            if length > 0:
                return length
    except Exception:
        pass
    raise ValueError("Не удалось определить длительность аудио. Установите ffprobe или пакет mutagen.")


def extract_chords(path: str, audio_duration: float) -> list[dict[str, Any]]:
    """Blocking Chordino work; called only in a worker thread."""
    raw = chordino.extract(path)
    items: list[dict[str, Any]] = []
    for index, event in enumerate(raw):
        start = max(0.0, float(event.timestamp))
        if start >= audio_duration:
            continue
        end = min(audio_duration, max(start, float(raw[index + 1].timestamp))) if index + 1 < len(raw) else audio_duration
        if end > start:
            items.append({"chord": str(event.chord), "time": start, "duration": end - start})

    filtered: list[dict[str, Any]] = []
    for chord in items:
        if chord["duration"] < MIN_DURATION and filtered:
            filtered[-1]["duration"] = chord["time"] + chord["duration"] - filtered[-1]["time"]
        else:
            filtered.append(chord.copy())

    merged: list[dict[str, Any]] = []
    for chord in filtered:
        if merged and merged[-1]["chord"] == chord["chord"]:
            merged[-1]["duration"] = chord["time"] + chord["duration"] - merged[-1]["time"]
        else:
            merged.append(chord.copy())

    for chord in merged:
        chord["time"] = max(0.0, min(float(chord["time"]), audio_duration))
        chord["duration"] = max(0.0, min(float(chord["duration"]), audio_duration - chord["time"]))
    if merged:
        merged[-1]["duration"] = max(0.0, audio_duration - merged[-1]["time"])
    return merged


async def analysis_worker() -> None:
    assert job_queue is not None
    while True:
        tmp_path, duration, future = await job_queue.get()
        try:
            if future.cancelled():
                continue
            try:
                chords = await run_in_threadpool(extract_chords, tmp_path, duration)
                if not future.done():
                    future.set_result(chords)
            except Exception as exc:
                logger.exception("Chord extraction failed")
                if not future.done():
                    future.set_exception(exc)
        finally:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
            except OSError:
                logger.warning("Could not remove temporary audio file: %s", tmp_path)
            job_queue.task_done()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global job_queue, worker_task
    job_queue = asyncio.Queue(maxsize=QUEUE_CAPACITY)
    worker_task = asyncio.create_task(analysis_worker(), name="chordino-worker")
    logger.info("HARMONIC API started; queue capacity=%d", QUEUE_CAPACITY)
    try:
        yield
    finally:
        if worker_task:
            worker_task.cancel()
            try:
                await worker_task
            except asyncio.CancelledError:
                pass
        logger.info("HARMONIC API stopped")


app = FastAPI(title="HARMONIC API", version="2.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[
    "http://localhost:3000", "http://127.0.0.1:3000",
    "http://localhost:5173", "http://127.0.0.1:5173",
], allow_methods=["GET", "POST"], allow_headers=["*"])


@app.get("/health")
async def health():
    return {"status": "ok", "queue_size": job_queue.qsize() if job_queue else 0,
            "queue_capacity": QUEUE_CAPACITY}


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    if job_queue is None:
        raise HTTPException(503, "Сервис ещё запускается. Попробуйте позже.")
    filename = Path(file.filename or "audio").name
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(415, "Неподдерживаемый формат. Используйте MP3, WAV, M4A, OGG, FLAC или AAC.")

    tmp_path: str | None = None
    total = 0
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            while True:
                chunk = await file.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"Файл слишком большой. Максимальный размер — {MAX_UPLOAD_BYTES // (1024 * 1024)} МБ.")
                tmp.write(chunk)

        if total == 0:
            raise HTTPException(400, "Загружен пустой файл.")
        if not has_audio_signature(tmp_path, suffix):
            raise HTTPException(415, "Содержимое файла не соответствует заявленному аудиоформату.")
        try:
            duration = await run_in_threadpool(probe_duration, tmp_path)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if duration > MAX_AUDIO_SECONDS:
            raise HTTPException(413, "Максимальная длительность трека — 60 минут.")

        loop = asyncio.get_running_loop()
        future = loop.create_future()
        try:
            job_queue.put_nowait((tmp_path, duration, future))
            tmp_path = None  # worker owns and removes it from here
        except asyncio.QueueFull:
            raise HTTPException(503, "Очередь анализа заполнена. Попробуйте через минуту.", headers={"Retry-After": "30"})

        logger.info("Queued filename=%r bytes=%d duration=%.2fs queue=%d", filename, total, duration, job_queue.qsize())
        try:
            chords = await future
        except asyncio.CancelledError:
            future.cancel()
            raise
        except Exception as exc:
            logger.exception("Analysis failed for %r", filename)
            raise HTTPException(500, "Не удалось обработать аудио. Проверьте файл или попробуйте другой формат.") from exc
        logger.info("Completed filename=%r chords=%d", filename, len(chords))
        return {"chords": chords}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Unexpected upload/API error for %r", filename)
        raise HTTPException(500, "Внутренняя ошибка сервера.") from exc
    finally:
        await file.close()
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
            except OSError:
                logger.warning("Could not remove temporary upload: %s", tmp_path)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
