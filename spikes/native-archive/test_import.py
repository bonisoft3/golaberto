import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_archive', HERE / 'import.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ArchivePreflightTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / 'source.sql'
        self.original_digest = archive.SOURCE_SHA256
        self.addCleanup(setattr, archive, 'SOURCE_SHA256', self.original_digest)

    def write_source(self, column='id', omit_sequence=False):
        lines = [f'COPY public.team ({column}) FROM stdin;\n', '1\n', '\\.\n']
        for i, name in enumerate(sorted(archive.REVISION_SEQUENCES)):
            if not (omit_sequence and i == 0):
                lines.append(f"SELECT pg_catalog.setval('public.{name}', 1, true);\n")
        self.source.write_text(''.join(lines))
        archive.SOURCE_SHA256 = hashlib.sha256(self.source.read_bytes()).hexdigest()

    def test_exact_source_and_reviewed_tables(self):
        self.write_source()
        archive.source_identity(self.source)
        headers, sequences = archive.inspect_source(self.source, {'public.team'})
        self.assertEqual(headers, {'public.team': ['id']})
        self.assertEqual(set(sequences), archive.REVISION_SEQUENCES)
        self.source.write_text(self.source.read_text() + '-- changed\n')
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            archive.source_identity(self.source)

    def test_credentials_and_missing_sequences_are_refused(self):
        self.write_source(column='password_hash')
        with self.assertRaisesRegex(ValueError, 'credential-bearing'):
            archive.inspect_source(self.source, {'public.team'})
        self.write_source(omit_sequence=True)
        with self.assertRaisesRegex(ValueError, 'revision sequences'):
            archive.inspect_source(self.source, {'public.team'})


if __name__ == '__main__':
    unittest.main()
