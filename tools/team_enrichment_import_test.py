import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("import_team_enrichment.py")
SPEC = importlib.util.spec_from_file_location("import_team_enrichment", MODULE_PATH)
assert SPEC and SPEC.loader
importer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(importer)


class TeamEnrichmentImportTest(unittest.TestCase):
    def test_namespaces_are_stable_for_source_ids(self):
        self.assertEqual(importer.legacy_uuid(7, 4), "a0700000-0000-4000-8000-000000000004")
        self.assertEqual(importer.legacy_uuid(13, 91), "a0d00000-0000-4000-8000-00000000005b")
        self.assertEqual(importer.legacy_uuid(19, 1), "a1300000-0000-4000-8000-000000000001")

    def test_odds_vector_keeps_real_zero_cells_and_null_positions(self):
        self.assertEqual(importer.yaml_numeric_vector("---\n- 0\n- 12.5\n- null\n"), [0.0, 12.5, None])

    def test_odds_vector_rejects_invalid_or_out_of_range_values(self):
        with self.assertRaises(ValueError):
            importer.yaml_numeric_vector("---\n- 100.1\n")
        with self.assertRaises(ValueError):
            importer.yaml_numeric_vector("---\n- infinity\n")

    def test_comments_select_only_team_rows_and_keep_legacy_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            (source / "comments.ndjson").write_text("\n".join([
                json.dumps([51, 4, "Team", 18, "A team comment", "2020-01-02 03:04:05.000000"]),
                json.dumps([52, 9, "Game", 18, "A game comment", "2020-01-02 03:04:05.000000"]),
            ]), encoding="utf-8")
            rows = list(importer.comments_from_export(source))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], importer.legacy_uuid(19, 51))
        self.assertEqual(rows[0][1], importer.legacy_uuid(7, 4))
        self.assertEqual(rows[0][2], importer.legacy_uuid(18, 18))

    def test_appearance_import_is_bounded_and_restartable(self):
        sql = importer.psql_apply_sql()
        self.assertIn("ORDER BY id LIMIT 1000", sql)
        self.assertIn("CALL pg_temp.import_player_ratings()", sql)
        self.assertIn("refresh_player_metric_queue(1000)", sql)
        self.assertIn("IS DISTINCT FROM (s.off_rating,s.def_rating)", sql)

    def test_apply_script_reports_and_skips_missing_import_targets(self):
        sql = importer.psql_apply_sql()
        self.assertIn("team coordinates skipped for missing team", sql)
        self.assertIn("appearance ratings skipped for missing player_game", sql)
        self.assertIn("team comments skipped for missing team/user", sql)
        self.assertIn("odds cells skipped for missing group/member", sql)
        self.assertIn("JOIN public.team_group m ON m.group_id=s.group_id AND m.team_id=s.team_id", sql)
        self.assertIn("refresh_team_profiles(500)", sql)


if __name__ == "__main__":
    unittest.main()
