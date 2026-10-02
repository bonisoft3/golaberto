import pathlib
import subprocess
import tempfile
import unittest

from seed_sql import render


class SeedSQLTest(unittest.TestCase):
    def test_defaults_escaping_and_replay(self):
        sql = render({"Group": [{"id": "a", "name": "King's \\ group"}, {"id": "b"}],
                      "Game": [{"id": "c", "played": False, "round": 1}]})
        self.assertIn("INSERT INTO stage_group (id, name)", sql)
        self.assertIn("'King''s \\ group'", sql)
        self.assertIn("INSERT INTO stage_group (id) VALUES", sql)
        self.assertIn("('c', false, 1)", sql)
        self.assertEqual(sql.count("ON CONFLICT (id) DO NOTHING;"), 3)
        with self.assertRaises(ValueError):
            render({"Game": [{"id": "a", "name": "bad\0value"}]})

    def test_committed_fixture_is_reproducible(self):
        app = pathlib.Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as tmp:
            output = pathlib.Path(tmp) / "seed.sql"
            subprocess.run(["python3", "tools/seed.py", str(output)], cwd=app, check=True)
            self.assertEqual(output.read_bytes(), (app / "services/database/sql/900_seed.sql").read_bytes())
        self.assertFalse((app / "seed.cue").exists(), "archive rows must stay outside CUE compilation")


if __name__ == "__main__":
    unittest.main()
