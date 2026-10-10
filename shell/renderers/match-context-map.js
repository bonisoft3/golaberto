export default function render(value) {
  const parts = String(value ?? "").split("\u001f");
  if (parts.length !== 10) {
    throw new Error("Match context map labels are missing");
  }
  const [
    homeLatText,
    homeLonText,
    awayLatText,
    awayLonText,
    homeName,
    awayName,
    distanceText,
    distanceLabel,
    mapLabel,
    missingLabel,
  ] = parts;
  if (
    homeLatText === "" || homeLonText === "" || awayLatText === "" ||
    awayLonText === ""
  ) {
    return [{
      tag: "p",
      attrs: { class: "match-context-location-empty" },
      children: [missingLabel],
    }];
  }
  const homeLat = Number(homeLatText);
  const homeLon = Number(homeLonText);
  const awayLat = Number(awayLatText);
  const awayLon = Number(awayLonText);
  const distance = Number(distanceText);
  if (
    !Number.isFinite(homeLat) || !Number.isFinite(homeLon) ||
    !Number.isFinite(awayLat) || !Number.isFinite(awayLon) ||
    Math.abs(homeLat) > 90 || Math.abs(awayLat) > 90 ||
    Math.abs(homeLon) > 180 || Math.abs(awayLon) > 180 ||
    !Number.isFinite(distance) || distance < 0
  ) {
    throw new Error("Invalid match context map: " + value);
  }

  const deltaLon = awayLon - homeLon;
  const deltaLat = awayLat - homeLat;
  const span = Math.max(Math.abs(deltaLon), Math.abs(deltaLat));
  const homeX = span === 0 ? 150 : 160 - deltaLon / span * 105;
  const awayX = span === 0 ? 170 : 160 + deltaLon / span * 105;
  const homeY = span === 0 ? 60 : 60 + deltaLat / span * 42;
  const awayY = span === 0 ? 60 : 60 - deltaLat / span * 42;
  const route = encodeURIComponent(
    homeLat + "," + homeLon + ";" + awayLat + "," + awayLon,
  );
  const centreLat = Math.round((homeLat + awayLat) * 5000) / 10000;
  const centreLon = Math.round((homeLon + awayLon) * 5000) / 10000;
  const href =
    "https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=" +
    route + "#map=5/" + centreLat + "/" + centreLon;
  const rounded = Math.round(distance * 10) / 10;

  return [{
    tag: "div",
    attrs: { class: "match-context-map" },
    children: [
      {
        tag: "p",
        attrs: { class: "match-context-distance" },
        children: [distanceLabel, " ", {
          tag: "strong",
          children: [String(rounded) + " km"],
        }],
      },
      {
        tag: "a",
        attrs: {
          class: "match-context-map-link",
          href,
          target: "_blank",
          rel: "noopener noreferrer",
        },
        children: [{
          tag: "svg",
          attrs: {
            viewBox: "0 0 320 120",
            role: "img",
            // The link's name: a renderer may label an SVG image, not an anchor.
            "aria-label": mapLabel + ": " + homeName + " – " + awayName,
          },
          children: [
            {
              tag: "line",
              attrs: {
                x1: homeX,
                y1: homeY,
                x2: awayX,
                y2: awayY,
                class: "match-context-route",
              },
            },
            {
              tag: "circle",
              attrs: {
                cx: homeX,
                cy: homeY,
                r: 7,
                class: "match-context-home-marker",
              },
            },
            {
              tag: "circle",
              attrs: {
                cx: awayX,
                cy: awayY,
                r: 7,
                class: "match-context-away-marker",
              },
            },
          ],
        }],
      },
      {
        tag: "p",
        attrs: { class: "match-context-map-teams" },
        children: [
          { tag: "span", children: [homeName] },
          " · ",
          { tag: "span", children: [awayName] },
          " · ",
          {
            tag: "a",
            attrs: {
              href,
              target: "_blank",
              rel: "noopener noreferrer",
            },
            children: [mapLabel],
          },
        ],
      },
    ],
  }];
}

render;
