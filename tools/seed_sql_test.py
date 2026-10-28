import collections
import json
import os
import pathlib
import runpy
from unittest.mock import patch
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

    def test_player_route_snapshot_joins_verified_archive(self):
        app = pathlib.Path(__file__).resolve().parent.parent
        previous = pathlib.Path.cwd()
        try:
            os.chdir(app)
            with patch("sys.argv", ["tools/seed.py", "unused"]), patch("seed_sql.write") as write:
                runpy.run_path("tools/seed.py")
        finally:
            os.chdir(previous)
        body = write.call_args.args[0]
        players = {r["id"]: r for r in body["Player"]}
        teams = {r["id"]: r for r in body["Team"]}
        championships = {r["id"]: r for r in body["Championship"]}
        upstream_teams = {r["upstream"]: r["name"] for r in json.loads((app / "tools/crawl/teams.json").read_text())}
        crawl = json.loads((app / "tools/crawl/players-1523-brasil-campeonato-brasileiro-2026.json").read_text())
        counts = collections.Counter((upstream_teams[r["team"]], r["name"]) for r in crawl)
        expected = {(upstream_teams[r["team"]], r["name"]): r for r in crawl
                    if counts[(upstream_teams[r["team"]], r["name"])] == 1 and (r["played"] or r["bench"])}
        seen = set()
        for row in body["PlayerStat"]:
            player, team, championship = players[row["player_id"]], teams[row["team_id"]], championships[row["championship_id"]]
            self.assertTrue(player["name"] and team["name"] and championship["name"] and championship["region_name"] and championship["begins"])
            self.assertEqual(row["id"], ":".join(row[k] for k in ("championship_id", "team_id", "player_id")))
            key = (team["name"], player["name"])
            self.assertNotIn(key, seen)
            seen.add(key)
            source = expected[key]
            for field in ("played", "bench", "minutes", "goals", "penalties", "own_goals", "yellow", "red"):
                self.assertEqual(row[field], source[field], (key, field))
            self.assertEqual(row["came_on"], source["substitute"])
            self.assertEqual(row["started"], source["played"] - source["substitute"])
        self.assertEqual(seen, set(expected))
        self.assertGreater(len(seen), 800)

    def test_committed_fixture_is_reproducible(self):
        app = pathlib.Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as tmp:
            output = pathlib.Path(tmp) / "seed.sql"
            subprocess.run(["python3", "tools/seed.py", str(output)], cwd=app, check=True)
            self.assertEqual(output.read_bytes(), (app / "services/database/sql/900_seed.sql").read_bytes())
        self.assertFalse((app / "seed.cue").exists(), "archive rows must stay outside CUE compilation")


if __name__ == "__main__":
    unittest.main()
