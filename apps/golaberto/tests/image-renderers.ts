import { assertEquals } from "jsr:@std/assert@1";
import badge from "../shell/renderers/team-badge.js";
import flag from "../shell/renderers/country-flag.js";

Deno.test("crests preserve imported hexadecimal IDs and seeded teams", () => {
  assertEquals(badge("a0700000-0000-4000-8000-00000000000a|Ignored label")[0].attrs.src,
    "https://d24oxbyqb2c11t.cloudfront.net/teams/logos/10/thumb.png");
  assertEquals(badge("07000000-0000-4000-8000-000000000007|Atlético-MG")[0].attrs.src,
    "https://d24oxbyqb2c11t.cloudfront.net/teams/logos/4/thumb.png");
  assertEquals(badge("00000000-0000-4000-8000-000000000000|Atlético-MG")[0].attrs.src,
    "https://d24oxbyqb2c11t.cloudfront.net/thumb.png");
  assertEquals(badge("a0700000-0000-4000-8000-000000000004|Atlético-MG")[0].attrs.alt, "");
});
Deno.test("country flags retain English archive names and Portuguese fixture aliases", () => {
  for (const name of ["Brasil", "Brazil", "Brasil - Campeonato Brasileiro 2026"])
    assertEquals(flag(name)[0].attrs.src, "https://d24oxbyqb2c11t.cloudfront.net/countries/flags/brazil_15.png");
  assertEquals(flag("Inglaterra")[0].attrs.src, "https://d24oxbyqb2c11t.cloudfront.net/countries/flags/england_15.png");
  assertEquals(flag("Europa - Champions League 2026/2027")[0].attrs.src,
    "https://d24oxbyqb2c11t.cloudfront.net/countries/flags/uefa_15.png");
  assertEquals(flag(""), []);
  assertEquals(flag("../<script>" )[0].attrs.src,
    "https://d24oxbyqb2c11t.cloudfront.net/countries/flags/script_15.png");
});

Deno.test("all 68 seed UUIDs retain their archive crest after renaming", () => {
  const expected = [
  [
    "07000000-0000-4000-8000-000000000001",
    17
  ],
  [
    "07000000-0000-4000-8000-000000000002",
    16
  ],
  [
    "07000000-0000-4000-8000-000000000003",
    5
  ],
  [
    "07000000-0000-4000-8000-000000000004",
    8
  ],
  [
    "07000000-0000-4000-8000-000000000005",
    74
  ],
  [
    "07000000-0000-4000-8000-000000000006",
    15
  ],
  [
    "07000000-0000-4000-8000-000000000007",
    4
  ],
  [
    "07000000-0000-4000-8000-000000000008",
    6
  ],
  [
    "07000000-0000-4000-8000-000000000009",
    10
  ],
  [
    "07000000-0000-4000-8000-000000000010",
    225
  ],
  [
    "07000000-0000-4000-8000-000000000011",
    14
  ],
  [
    "07000000-0000-4000-8000-000000000012",
    7
  ],
  [
    "07000000-0000-4000-8000-000000000013",
    67
  ],
  [
    "07000000-0000-4000-8000-000000000014",
    24
  ],
  [
    "07000000-0000-4000-8000-000000000015",
    584
  ],
  [
    "07000000-0000-4000-8000-000000000016",
    18
  ],
  [
    "07000000-0000-4000-8000-000000000017",
    79
  ],
  [
    "07000000-0000-4000-8000-000000000018",
    20
  ],
  [
    "07000000-0000-4000-8000-000000000019",
    110
  ],
  [
    "07000000-0000-4000-8000-000000000020",
    318
  ],
  [
    "07000000-0000-4000-8000-000000000225",
    37
  ],
  [
    "07000000-0000-4000-8000-000000000230",
    36
  ],
  [
    "07000000-0000-4000-8000-000000000231",
    34
  ],
  [
    "07000000-0000-4000-8000-000000000232",
    632
  ],
  [
    "07000000-0000-4000-8000-000000000234",
    32
  ],
  [
    "07000000-0000-4000-8000-000000000236",
    38
  ],
  [
    "07000000-0000-4000-8000-000000000238",
    173
  ],
  [
    "07000000-0000-4000-8000-000000000240",
    27
  ],
  [
    "07000000-0000-4000-8000-000000000243",
    35
  ],
  [
    "07000000-0000-4000-8000-000000000244",
    44
  ],
  [
    "07000000-0000-4000-8000-000000000245",
    70
  ],
  [
    "07000000-0000-4000-8000-000000000246",
    12
  ],
  [
    "07000000-0000-4000-8000-000000000247",
    22
  ],
  [
    "07000000-0000-4000-8000-000000000249",
    73
  ],
  [
    "07000000-0000-4000-8000-000000000250",
    279
  ],
  [
    "07000000-0000-4000-8000-000000000251",
    80
  ],
  [
    "07000000-0000-4000-8000-000000000252",
    588
  ],
  [
    "07000000-0000-4000-8000-000000000253",
    77
  ],
  [
    "07000000-0000-4000-8000-000000000254",
    96
  ],
  [
    "07000000-0000-4000-8000-000000000255",
    11
  ],
  [
    "07000000-0000-4000-8000-000000000256",
    429
  ],
  [
    "07000000-0000-4000-8000-000000000257",
    550
  ],
  [
    "07000000-0000-4000-8000-000000000258",
    87
  ],
  [
    "07000000-0000-4000-8000-000000000259",
    69
  ],
  [
    "07000000-0000-4000-8000-000000000260",
    457
  ],
  [
    "07000000-0000-4000-8000-000000000261",
    68
  ],
  [
    "07000000-0000-4000-8000-000000000262",
    95
  ],
  [
    "07000000-0000-4000-8000-000000000263",
    125
  ],
  [
    "07000000-0000-4000-8000-000000000264",
    9
  ],
  [
    "07000000-0000-4000-8000-000000000101",
    251
  ],
  [
    "07000000-0000-4000-8000-000000000102",
    229
  ],
  [
    "07000000-0000-4000-8000-000000000103",
    253
  ],
  [
    "07000000-0000-4000-8000-000000000104",
    327
  ],
  [
    "07000000-0000-4000-8000-000000000226",
    26
  ],
  [
    "07000000-0000-4000-8000-000000000227",
    1553
  ],
  [
    "07000000-0000-4000-8000-000000000228",
    1558
  ],
  [
    "07000000-0000-4000-8000-000000000229",
    1260
  ],
  [
    "07000000-0000-4000-8000-000000000233",
    40
  ],
  [
    "07000000-0000-4000-8000-000000000235",
    1252
  ],
  [
    "07000000-0000-4000-8000-000000000237",
    1528
  ],
  [
    "07000000-0000-4000-8000-000000000239",
    33
  ],
  [
    "07000000-0000-4000-8000-000000000241",
    1554
  ],
  [
    "07000000-0000-4000-8000-000000000242",
    1526
  ],
  [
    "07000000-0000-4000-8000-000000000248",
    2064
  ],
  [
    "07000000-0000-4000-8000-000000000265",
    21
  ],
  [
    "07000000-0000-4000-8000-000000000266",
    23
  ],
  [
    "07000000-0000-4000-8000-000000000267",
    13
  ],
  [
    "07000000-0000-4000-8000-000000000268",
    84
  ]
];
  for (const [id, upstream] of expected) {
    assertEquals(badge(id + "|Renamed team")[0].attrs.src,
      "https://d24oxbyqb2c11t.cloudfront.net/teams/logos/" + upstream + "/thumb.png");
  }
});

Deno.test("game flags require the championship switch and a known country", () => {
  assertEquals(flag("false|Brazil"), []);
  assertEquals(flag("|Brazil"), []);
  assertEquals(flag("true|"), []);
  assertEquals(flag(null), []);
  assertEquals(flag("true|Brasil"), flag("Brazil"));
  assertEquals(flag("true|Argentina"), flag("Argentina"));
});

Deno.test("geography labels translate countries and tournament prefixes while preserving archive text", async () => {
  const { default: render } = await import("../shell/renderers/geography-label.js");
  const labels = JSON.stringify([["Germany", "Alemanha"], ["Europe", "Europa"]]);
  assertEquals(render(`Germany|${labels}`), ["Alemanha"]);
  assertEquals(render(`Europe - League 2026|${labels}`), ["Europa - League 2026"]);
  assertEquals(render(`Unmappedland|${labels}`), ["Unmappedland"]);
  assertEquals(render(`constructor|${labels}`), ["constructor"]);
  assertEquals(render(`Germany|⟦${labels}⟧`), ["Alemanha"]);
});
