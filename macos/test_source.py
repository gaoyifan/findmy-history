"""Exercise transaction boundaries and writer resumption without private fixtures."""

import http.client
import plistlib
import signal
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import source


class SnapshotTests(unittest.TestCase):
    def test_item_cache_uses_identifier_and_preserves_location_time(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            key = bytes(range(32))
            (cache / "FMIPDataManager.bplist").write_bytes(plistlib.dumps({"symmetricKey": {"key": {"data": key}}}))
            records = [
                {
                    "identifier": "tag-1",
                    "name": "Keys",
                    "location": {
                        "latitude": 30.0,
                        "longitude": 120.0,
                        "horizontalAccuracy": 12.0,
                        "timeStamp": 1792588200000,
                    },
                },
                {"identifier": "tag-2", "name": "Bag"},
            ]
            cipher = source.ChaCha20_Poly1305.new(key=key, nonce=bytes(12))
            encrypted, tag = cipher.encrypt_and_digest(plistlib.dumps(records))
            (cache / "Items.data").write_bytes(plistlib.dumps({"encryptedData": bytes(12) + encrypted + tag}))
            with patch.object(source, "CACHE", cache), patch.object(source, "KEYS", cache):
                locations = source.cache_records("item", "Items.data")
            self.assertEqual(
                locations[0],
                {
                    "kind": "item",
                    "id": "tag-1",
                    "name": "Keys",
                    "latitude": 30.0,
                    "longitude": 120.0,
                    "accuracy": 12.0,
                    "timestamp": "2026-10-21T13:10:00+00:00",
                },
            )
            self.assertEqual(locations[1]["id"], "tag-2")
            self.assertIsNone(locations[1]["latitude"])
            self.assertIsNone(locations[1]["timestamp"])

    def page(self, marker):
        data = bytearray(bytes([marker]) * source.PAGE)
        data[:16] = b"SQLite format 3\0"
        data[16:18] = b"\x10\x00"
        data[20] = 12
        return bytes(data)

    def wal(self, frames):
        header = struct.pack(">6I", 0x377F0682, 3007000, source.PAGE, 0, 123, 456)
        chain = source.checksum(header, "<")
        result = header + struct.pack(">2I", *chain)
        for number, commit, page in frames:
            header = struct.pack(">4I", number, commit, 123, 456)
            chain = source.checksum(header[:8] + page, "<", chain)
            result += header + struct.pack(">2I", *chain) + page
        return result

    @patch.object(source, "decrypt_page", side_effect=lambda _key, page, _number: page)
    def test_only_committed_frames_are_applied(self, _decrypt):
        original, committed, uncommitted = self.page(1), self.page(2), self.page(3)
        wal = self.wal([(1, 1, committed), (1, 0, uncommitted)])
        self.assertEqual(source.decrypt_database(bytes(32), original, wal), committed)
        self.assertEqual(source.decrypt_database(bytes(32), original, wal[:-8]), committed)

    @patch.object(source, "decrypt_page", side_effect=lambda _key, page, _number: page)
    def test_corrupt_tail_does_not_replace_committed_page(self, _decrypt):
        original, committed = self.page(1), self.page(2)
        wal = bytearray(self.wal([(1, 1, committed), (1, 1, self.page(3))]))
        wal[-1] ^= 1
        self.assertEqual(source.decrypt_database(bytes(32), original, wal), committed)

    @patch.object(source, "decrypt_page", side_effect=lambda _key, page, _number: page)
    def test_commit_can_truncate_database(self, _decrypt):
        original, committed = self.page(1), self.page(2)
        self.assertEqual(source.decrypt_database(bytes(32), original * 2, self.wal([(1, 1, committed)])), committed)

    def test_writer_is_resumed_when_copy_fails(self):
        with (
            patch.object(source.subprocess, "check_output", side_effect=["123\n", "T\n"]),
            patch.object(source.os, "kill") as kill,
            patch.object(source.Path, "read_bytes", side_effect=PermissionError),
        ):
            with self.assertRaises(PermissionError):
                source.copy_database()
            self.assertEqual(kill.call_args_list[-1].args, (123, signal.SIGCONT))


class FeedTests(unittest.TestCase):
    def setUp(self):
        self.feed = source.Feed()
        self.feed.sequence = 1
        self.feed.payload = b'{"private":"snapshot"}'
        self.feed.sampled_at = time.monotonic()
        self.patch = patch.object(source, "FEED", self.feed)
        self.patch.start()
        self.server = source.http.server.ThreadingHTTPServer(("127.0.0.1", 0), source.Handler)
        self.server.daemon_threads = True
        self.server.authorization = b"Bearer test-source-token"
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.feed.stopping.set()
        with self.feed.condition:
            self.feed.condition.notify_all()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.patch.stop()

    def test_missing_or_wrong_token_cannot_read_health_or_events(self):
        for path in ["/healthz", "/events"]:
            for authorization in [None, "Bearer wrong", "Basic test-source-token", "Bearer é"]:
                with self.subTest(path=path, authorization=authorization):
                    client = http.client.HTTPConnection(*self.server.server_address, timeout=2)
                    try:
                        headers = {} if authorization is None else {"Authorization": authorization}
                        client.request("GET", path, headers=headers)
                        response = client.getresponse()
                        self.assertEqual(response.status, 401)
                        self.assertEqual(response.getheader("WWW-Authenticate"), "Bearer")
                        self.assertNotIn(b"snapshot", response.read())
                    finally:
                        client.close()

    def test_valid_token_reads_health_and_snapshot(self):
        for path in ["/healthz", "/events"]:
            with self.subTest(path=path):
                client = http.client.HTTPConnection(*self.server.server_address, timeout=2)
                try:
                    client.request("GET", path, headers={"Authorization": "Bearer test-source-token"})
                    response = client.getresponse()
                    self.assertEqual(response.status, 200)
                    if path == "/healthz":
                        self.assertEqual(response.read(), b"ok\n")
                    else:
                        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
                        self.assertEqual(response.readline(), b"event: snapshot\n")
                        self.assertEqual(response.readline(), b"data: " + self.feed.payload + b"\n")
                finally:
                    client.close()

    def test_worker_rejects_empty_token_before_listening(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token"
            token_file.touch()
            with self.assertRaisesRegex(ValueError, "token file is empty"):
                source.worker(None, "127.0.0.1", token_file)


if __name__ == "__main__":
    unittest.main()
