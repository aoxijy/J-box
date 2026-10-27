import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('resolver', Path(__file__).with_name('resolve-latest.py'))
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)


class ResolverTests(unittest.TestCase):
    def test_reject_unstable_or_malformed_releases(self):
        for release in ({'tag_name': 'v1.15.0-beta.1'}, {'tag_name': 'main'},
                        {'tag_name': 'v1.14.4', 'draft': True},
                        {'tag_name': 'v1.14.4', 'prerelease': True}):
            with self.subTest(release=release), self.assertRaises(ValueError):
                resolver.stable_version(release)

    def test_numeric_order(self):
        self.assertGreater(resolver.version_tuple('1.14.10'), resolver.version_tuple('1.14.9'))

    def test_freeze_source_and_version_together(self):
        release = {'tag_name': 'v1.14.4', 'html_url': 'https://github.com/SagerNet/sing-box/releases/tag/v1.14.4'}
        calls = []

        def request(url, authenticated=False):
            calls.append((url, authenticated))
            return io.BytesIO(json.dumps(release).encode() if authenticated else b'test source archive')

        with tempfile.TemporaryDirectory() as directory, patch.object(resolver, 'request', request):
            resolver.main(directory)
            output = Path(directory)
            record = json.loads((output / 'resolution.json').read_text())
            checksum = resolver.hashlib.sha256((output / 'source.tar.gz').read_bytes()).hexdigest()
            self.assertEqual(record['source_sha256'], checksum)
            self.assertIn('SINGBOX_VERSION="1.14.4-jbox-tcp2"', (output / 'versions.sh').read_text())
            self.assertIn(checksum, (output / 'versions.sh').read_text())
            self.assertEqual(len(calls), 2)
            self.assertFalse(calls[1][1], 'Do not forward GitHub API token to archive download')

    def test_no_silent_fallback_on_network_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(resolver, 'request', side_effect=OSError('offline')):
            with self.assertRaises(OSError):
                resolver.main(directory)
            self.assertFalse((Path(directory) / 'versions.sh').exists())

    def test_refuse_downgrade(self):
        release = {'tag_name': 'v1.0.0'}
        with tempfile.TemporaryDirectory() as directory, patch.object(resolver, 'request', return_value=io.BytesIO(json.dumps(release).encode())):
            with self.assertRaises(ValueError):
                resolver.main(directory)


if __name__ == '__main__':
    unittest.main()
