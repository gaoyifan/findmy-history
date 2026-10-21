"""Find My cache snapshots; decryption keys stay on the logged-in Mac.

LocalStorage cipher derived from sabey/findmy-key-extractor; FMIP envelope
from PnutCN/findmy-cache-decryptor. See THIRD_PARTY_NOTICES.md.
"""

import argparse
import datetime as dt
import http.server
import json
import math
import os
from pathlib import Path
import plistlib
import shlex
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time

from Crypto.Cipher import AES, ChaCha20_Poly1305

UTC = dt.timezone.utc
PAGE = 4096
STATE = Path.home() / ".local/state/findmy"
KEYS = STATE / "keys"
DATABASE = (
    Path.home()
    / "Library/Group Containers/group.com.apple.findmy.findmylocateagent/Library/Application Support/LocalStorage.db"
)
CACHE = Path.home() / "Library/Caches/com.apple.findmy.fmipcore"


def checksum(data, endian, seed=(0, 0)):
    a, b = seed
    for x, y in struct.iter_unpack(endian + "II", data):
        a = (a + x + b) & 0xFFFFFFFF
        b = (b + y + a) & 0xFFFFFFFF
    return a, b


def decrypt_page(key, page, number):
    iv = struct.pack("<I", number) + page[4084:]
    stream = AES.new(key, AES.MODE_CBC, iv).encrypt(bytes(PAGE))
    plain = bytes(a ^ b for a, b in zip(page[:4084], stream)) + page[4084:]
    if number == 1:
        plain = plain[:16] + page[16:24] + plain[24:]
    return plain


def decrypt_database(key, data, wal):
    if len(key) != 32 or not data or len(data) % PAGE or data[16:18] != b"\x10\x00" or data[20] != 12:
        raise ValueError("Unsupported LocalStorage key or page format")
    result = bytearray().join(decrypt_page(key, data[i : i + PAGE], i // PAGE + 1) for i in range(0, len(data), PAGE))
    frames = []
    committed = 0
    pages = None
    if len(wal) >= 32:
        magic, version, size = struct.unpack(">III", wal[:12])
        if magic not in (0x377F0682, 0x377F0683) or version != 3007000 or size != PAGE:
            raise ValueError("Unsupported WAL format")
        endian = "<" if magic == 0x377F0682 else ">"
        chain = checksum(wal[:24], endian)
        if chain != struct.unpack(">II", wal[24:32]):
            raise ValueError("Invalid WAL header checksum")
        for offset in range(32, len(wal) - PAGE - 24 + 1, PAGE + 24):
            header, page = wal[offset : offset + 24], wal[offset + 24 : offset + 24 + PAGE]
            number, size = struct.unpack(">II", header[:8])
            updated = checksum(header[:8] + page, endian, chain)
            if number < 1 or header[8:16] != wal[16:24] or updated != struct.unpack(">II", header[16:24]):
                break
            chain = updated
            frames.append((number, page))
            if size:
                committed, pages = len(frames), size
        for number, page in frames[:committed]:
            end = number * PAGE
            if end > len(result):
                result.extend(bytes(end - len(result)))
            result[end - PAGE : end] = decrypt_page(key, page, number)
        if pages is not None:
            result = result[: pages * PAGE]
    if result[:16] != b"SQLite format 3\0":
        raise ValueError("LocalStorage key mismatch")
    return result


def copy_database():
    # findmylocateagent is the sole writer on the validated macOS build. Pause
    # only for the in-memory copy; always resume before decrypting or querying.
    pid = int(
        subprocess.check_output(
            ["/usr/bin/pgrep", "-u", str(os.getuid()), "-x", "findmylocateagent"], text=True
        ).strip()
    )
    try:
        os.kill(pid, signal.SIGSTOP)
        deadline = time.monotonic() + 1
        while "T" not in subprocess.check_output(["/bin/ps", "-o", "state=", "-p", str(pid)], text=True):
            if time.monotonic() >= deadline:
                raise RuntimeError("Location writer did not stop")
            time.sleep(0.001)
        data = DATABASE.read_bytes()
        wal_path = DATABASE.with_name(DATABASE.name + "-wal")
        wal = wal_path.read_bytes() if wal_path.exists() else b""
        return data, wal
    finally:
        os.kill(pid, signal.SIGCONT)


def timestamp(value, epoch=0):
    if isinstance(value, dt.datetime):
        return value.replace(tzinfo=UTC).isoformat() if value.tzinfo is None else value.astimezone(UTC).isoformat()
    if isinstance(value, (int, float)) and math.isfinite(value) and value > 0:
        return dt.datetime.fromtimestamp(value + epoch, UTC).isoformat()
    return None


def point(kind, ident, name, location, stamp):
    lat, lon = location.get("latitude"), location.get("longitude")
    if not (
        isinstance(lat, (int, float))
        and isinstance(lon, (int, float))
        and math.isfinite(lat)
        and math.isfinite(lon)
        and -90 <= lat <= 90
        and -180 <= lon <= 180
    ):
        lat = lon = None
    accuracy = location.get("horizontalAccuracy")
    if not isinstance(accuracy, (int, float)) or not math.isfinite(accuracy) or accuracy < 0:
        accuracy = None
    return {
        "kind": kind,
        "id": ident,
        "name": name or ident,
        "latitude": lat,
        "longitude": lon,
        "accuracy": accuracy,
        "timestamp": stamp,
    }


def people():
    data, wal = copy_database()
    decrypted = decrypt_database((KEYS / "LocalStorage.key").read_bytes(), data, wal)
    # A deserialized WAL-mode image tries to open an on-disk WAL. Frames have
    # already been merged, so mark this private memory image as rollback mode.
    decrypted[18:20] = b"\x01\x01"
    # Keep plaintext SQLite in memory; no accumulating sensitive snapshots.
    with sqlite3.connect(":memory:") as connection:
        connection.deserialize(bytes(decrypted))
        connection.execute("PRAGMA query_only=ON")
        if connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("LocalStorage consistency check failed")
        rows = connection.execute(
            "SELECT f.handleIdentifier,f.handleServerIdentifier,s.value FROM friends f LEFT JOIN secureLocations s ON s.serverUserID=f.handleServerIdentifier"
        ).fetchall()
    result = []
    for name, ident, blob in rows:
        location = plistlib.loads(blob) if blob else {}
        result.append(point("person", ident, name, location, timestamp(location.get("timestamp"), 978307200)))
    return result


def cache_records(kind, filename):
    envelope = plistlib.loads((CACHE / filename).read_bytes())
    key = plistlib.loads((KEYS / "FMIPDataManager.bplist").read_bytes())["symmetricKey"]["key"]["data"]
    encrypted = envelope["encryptedData"]
    plain = ChaCha20_Poly1305.new(key=key, nonce=encrypted[:12]).decrypt_and_verify(encrypted[12:-16], encrypted[-16:])
    records = plistlib.loads(plain)
    if not isinstance(records, list):
        raise ValueError("Unsupported cache record structure")
    result = []
    for record in records:
        location = record.get("location")
        if not isinstance(location, dict):
            location = {}
        stamp = location.get("timeStamp")
        stamp = timestamp(stamp / 1000) if isinstance(stamp, (int, float)) else None
        ident = record["identifier" if kind == "item" else "id"]
        result.append(point(kind, ident, record.get("name"), location, stamp))
    return result


def snapshot():
    result = {"observedAt": dt.datetime.now(UTC).isoformat(), "locations": [], "sources": {}}
    for name, read in (
        ("people", people),
        ("devices", lambda: cache_records("device", "Devices.data")),
        ("items", lambda: cache_records("item", "Items.data")),
    ):
        try:
            locations = read()
            result["locations"].extend(locations)
            result["sources"][name] = {"ok": True, "count": len(locations)}
        except Exception as error:
            # Diagnostics contain exception class, never the decrypted record/key.
            message = (
                "缓存尚未生成"
                if isinstance(error, FileNotFoundError) and name == "items"
                else type(error).__name__ + ": " + str(error)
            )
            result["sources"][name] = {"ok": False, "count": 0, "error": message}
    return result


class Feed:
    def __init__(self):
        self.condition = threading.Condition()
        self.sequence = 0
        self.payload = b""
        self.sampled_at = 0
        self.stopping = threading.Event()

    def collect(self):
        while not self.stopping.is_set():
            payload = json.dumps(snapshot(), ensure_ascii=False, allow_nan=False).encode()
            with self.condition:
                self.sequence += 1
                self.payload = payload
                self.sampled_at = time.monotonic()
                self.condition.notify_all()
            self.stopping.wait(30)


FEED = Feed()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/healthz":
            healthy = bool(FEED.payload) and time.monotonic() - FEED.sampled_at < 90
            self.send_response(200 if healthy else 503)
            self.end_headers()
            self.wfile.write(b"ok\n" if healthy else b"stale or starting\n")
            return
        if self.path != "/events":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.connection.settimeout(20)
        sequence = 0
        try:
            while not FEED.stopping.is_set():
                with FEED.condition:
                    FEED.condition.wait_for(lambda: sequence != FEED.sequence or FEED.stopping.is_set(), 10)
                    current, payload = FEED.sequence, FEED.payload
                if current != sequence:
                    self.wfile.write(b"event: snapshot\ndata: " + payload + b"\n\n")
                    sequence = current
                else:
                    self.wfile.write(b": heartbeat\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass


def worker(pid_file):
    # The port stays exclusive until the collector finishes shutting down.
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), Handler)
    server.daemon_threads = True
    # Device caches need their producer running; restore its last tab in
    # the background without taking focus from the Photos exporter.
    subprocess.run(["/usr/bin/open", "-g", "-a", "FindMy"], check=True)
    if pid_file:
        Path(pid_file).write_text(str(os.getpid()))

    def stop(_signum, _frame):
        FEED.stopping.set()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    collector = threading.Thread(target=FEED.collect, name="cache-reader")
    collector.start()
    try:
        server.serve_forever()
    finally:
        FEED.stopping.set()
        # Finish any paused-writer snapshot before the interpreter exits.
        collector.join()
        server.server_close()


def terminal():
    # Terminal already has Full Disk Access on this VM, as with the Photos
    # exporter. launchd/SSH alone cannot read the protected Find My container.
    with tempfile.TemporaryDirectory(prefix="findmy-terminal-") as directory:
        directory = Path(directory)
        script = directory / "start.command"
        exit_file, pid_file = directory / "exit", directory / "pid"
        command = shlex.join([sys.executable, str(Path(__file__).resolve()), "--worker", "--pid-file", str(pid_file)])
        log = shlex.quote(str(Path.home() / "Library/Logs/findmy-source.log"))
        script.write_text(
            f'#!/bin/sh\n{command} >> {log} 2>&1\nstatus=$?\nprintf \'%s\' "$status" > {shlex.quote(str(exit_file))}\nexit "$status"\n'
        )
        script.chmod(0o700)
        apple = (
            'tell application "Terminal"\ndo script '
            + json.dumps(shlex.quote(str(script)))
            + "\nreturn id of front window\nend tell"
        )
        window = int(subprocess.check_output(["/usr/bin/osascript", "-e", apple], text=True).strip())

        def stop(_signum, _frame):
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        started = time.monotonic()
        try:
            while not exit_file.exists():
                if pid_file.exists():
                    try:
                        os.kill(int(pid_file.read_text()), 0)
                    except ProcessLookupError:
                        return 1
                elif time.monotonic() - started > 120:
                    return 1
                time.sleep(1)
            return int(exit_file.read_text())
        finally:
            if pid_file.exists():
                try:
                    os.kill(int(pid_file.read_text()), signal.SIGTERM)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + 3
            while pid_file.exists() and not exit_file.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            subprocess.run(
                ["/usr/bin/osascript", "-e", f'tell application "Terminal" to close window id {window}'],
                capture_output=True,
            )


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--pid-file")
    args = parser.parse_args()
    if args.worker:
        worker(args.pid_file)
    else:
        sys.exit(terminal())
